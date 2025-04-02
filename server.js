const express = require('express');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');
const { parse } = require('csv-parse/sync');

dotenv.config();

const app = express();
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const snsClient = new SNSClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

app.get('/', (_, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Sender</title>
        <link rel="stylesheet" href="/style.css">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/tinymce/6.7.1/tinymce.min.js"></script>
    </head>
    <body>
        <h1>Bulk Email Sender</h1>
        <form id="emailForm">
            <label>Subject:</label><br>
            <input type="text" id="subject" required><br>
            <label>Email Content:</label><br>
            <textarea id="editor"></textarea><br>
            <label>Upload CSV (email column):</label><br>
            <input type="file" id="csvFile" accept=".csv" required><br>
            <button type="submit">Send Emails</button>
        </form>
        <h3>Live Report</h3>
        <div>Total Emails: <span id="totalEmails">0</span></div>
        <div>Sent Emails: <span id="sentEmails">0</span></div>
        <pre id="report"></pre>
        <script src="/script.js"></script>
    </body>
    </html>
    `;
    res.send(html);
});

// Function to upload image to S3 and get public URL
const uploadImageToS3 = async (base64Data) => {
    const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const key = `image-${Date.now()}.png`;
    const params = {
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: 'image/png',
    };

    try {
        await s3Client.send(new PutObjectCommand(params));
        return `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    } catch (err) {
        console.error(`[S3 Error] Failed to upload image: ${err.message}`);
        return null;
    }
};

// Email validation function
const isValidEmail = (email) => {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    const isValid = email && typeof email === 'string' && emailRegex.test(email.trim());
    if (!isValid) console.log(`[Debug] Invalid email rejected: ${email}`);
    return isValid;
};

// Batch processing function (12 emails/sec)
const sendEmailsInBatches = async (recipients, subject, htmlContent, res) => {
    const batchSize = 12;
    let sentCount = 0;
    const errors = [];

    console.log(`[Debug] Starting batch process with ${recipients.length} recipients`);

    let updatedHtmlContent = htmlContent;
    const base64Regex = /<img[^>]+src=["'](data:image\/\w+;base64,[^"']+)["']/g;
    let match;
    while ((match = base64Regex.exec(htmlContent)) !== null) {
        const base64Data = match[1];
        const s3Url = await uploadImageToS3(base64Data);
        if (s3Url) {
            updatedHtmlContent = updatedHtmlContent.replace(base64Data, s3Url);
        } else {
            updatedHtmlContent = updatedHtmlContent.replace(match[0], '[Image upload failed]');
        }
    }

    res.write(`data:Total emails to send:${recipients.length}\n\n`);

    for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        console.log(`[Debug] Processing batch ${i / batchSize + 1}: ${batch.join(', ')}`);

        const promises = batch.map(async (email) => {
            if (!isValidEmail(email)) {
                const errorMsg = `Invalid email format: ${email}`;
                console.error(`[Error] ${errorMsg}`);
                errors.push({ email, error: errorMsg });
                res.write(`data:Error:${sentCount}:${email}:${errorMsg}\n\n`);
                return;
            }

            const unsubscribeId = `${email}-${Date.now()}`;
            const unsubscribeLink = `${process.env.BASE_URL || 'https://mass-email-sender-whyh.onrender.com'}/unsubscribe?id=${unsubscribeId}`;
            const fullHtml = `${updatedHtmlContent}<br><br><p>If you don't find this email useful, please <a href="${unsubscribeLink}">unsubscribe</a></p>`;

            const params = {
                Source: process.env.SES_SENDER_EMAIL,
                Destination: { ToAddresses: [email] },
                Message: {
                    Subject: { Data: subject },
                    Body: { Html: { Data: fullHtml } },
                },
                ConfigurationSetName: 'EmailTrackingConfig',
            };

            console.log(`[Debug] Sending to ${email} with Source: ${process.env.SES_SENDER_EMAIL}`);

            try {
                await sesClient.send(new SendEmailCommand(params));
                sentCount++;
                res.write(`data:Sent:${sentCount}:${email}\n\n`);
            } catch (err) {
                console.error(`[SES Error] Email: ${email}, Error: ${err.message}`);
                errors.push({ email, error: err.message });
                res.write(`data:Error:${sentCount}:${email}:${err.message}\n\n`);
            }
        });

        await Promise.all(promises);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.write(`data:Completed:${sentCount}:${errors.length}\n\n`);
    console.log(`[Batch Complete] Sent: ${sentCount}, Failed: ${errors.length}`);
    if (errors.length) console.error(`[Batch Errors] ${JSON.stringify(errors, null, 2)}`);
    res.end();
};

// Endpoint to handle email sending
app.post('/send-emails', (req, res) => {
    const { subject, htmlContent, csvFile } = req.body;
    try {
        console.log(`[Debug] Raw CSV data: ${csvFile.slice(0, 200)}...`); // More characters for clarity
        const parsed = parse(csvFile, { columns: true, trim: true, skip_empty_lines: true });
        console.log(`[Debug] Parsed rows: ${JSON.stringify(parsed.slice(0, 5), null, 2)}`);

        // Try multiple column name variations
        const recipients = parsed
            .map(row => {
                const email = row.email || row.Email || row.EMAIL || row.emails || row['e-mail'];
                return email ? email.trim() : null;
            })
            .filter(email => isValidEmail(email));
        console.log(`[Debug] Parsed ${recipients.length} valid emails: ${recipients.slice(0, 5)}...`);

        if (recipients.length === 0) {
            console.error('[Error] No valid emails found in CSV');
            res.write(`data:Error:0:No valid emails found in CSV\n\n`);
            res.write(`data:Completed:0:0\n\n`);
            res.end();
            return;
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        sendEmailsInBatches(recipients, subject, htmlContent, res);
    } catch (err) {
        console.error(`[CSV Parse Error] ${err.message}`);
        res.write(`data:Error:0:CSV parsing failed: ${err.message}\n\n`);
        res.write(`data:Completed:0:0\n\n`);
        res.end();
    }
});

// Unsubscribe endpoint
app.get('/unsubscribe', async (req, res) => {
    const unsubscribeId = req.query.id;
    try {
        await snsClient.send(new PublishCommand({
            TopicArn: process.env.SNS_TOPIC_ARN,
            Message: `Unsubscribe request: ${unsubscribeId}`,
        }));
        console.log(`[SNS] Unsubscribed: ${unsubscribeId}`);
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Unsubscribe</title>
            </head>
            <body>
                <h1>Thank you for your response</h1>
                <p>You are successfully unsubscribed!</p>
            </body>
            </html>
        `);
    } catch (err) {
        console.error(`[SNS Error] ${err.message}`);
        res.send('Error processing unsubscribe request.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));