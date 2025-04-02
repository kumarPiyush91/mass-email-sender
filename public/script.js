document.getElementById('emailForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const subject = document.getElementById('subject').value;
    const htmlContent = tinymce.get('editor').getContent();
    const csvFile = document.getElementById('csvFile').files[0];
    const report = document.getElementById('report');
    const totalEmails = document.getElementById('totalEmails');
    const sentEmails = document.getElementById('sentEmails');

    report.textContent = 'Sending emails...\n';
    sentEmails.textContent = '0';

    const reader = new FileReader();
    reader.onload = async (event) => {
        const csvData = event.target.result;
        const emails = csvData.split('\n').filter(line => line.trim()).length - 1;
        totalEmails.textContent = emails;
        console.log(`[Debug] Client-side: Total emails detected: ${emails}`);
        console.log(`[Debug] CSV preview: ${csvData.slice(0, 200)}...`);

        try {
            const response = await fetch('/send-emails', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject, htmlContent, csvFile: csvData }),
            });

            if (!response.ok) {
                throw new Error(`Server responded with status: ${response.status}`);
            }

            const readerStream = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await readerStream.read();
                if (done) break;
                const message = decoder.decode(value).trim();
                const parts = message.split(':');

                if (parts[0] === 'data') {
                    const data = parts.slice(1).join(':');
                    if (data.startsWith('Sent')) {
                        const [_, count, email] = data.split(':');
                        sentEmails.textContent = count; // Live update
                        report.textContent += `Sent to ${email}\n`;
                    } else if (data.startsWith('Error')) {
                        const [_, count, email, ...errorParts] = data.split(':');
                        const errorMsg = errorParts.join(':');
                        console.error(`[Client Error] ${email}: ${errorMsg}`);
                        report.textContent += `Error: ${errorMsg}\n`;
                    } else if (data.startsWith('Completed')) {
                        const [_, sent, failed] = data.split(':');
                        report.textContent += `Completed! Sent: ${sent}, Failed: ${failed}\n`;
                    } else if (data.startsWith('Total emails to send')) {
                        report.textContent += `${data}\n`;
                    }
                }
                report.scrollTop = report.scrollHeight;
            }
        } catch (err) {
            console.error(`[Client Error] Fetch failed: ${err.message}`);
            report.textContent += `Client-side error: ${err.message}\n`;
        }
    };
    reader.onerror = (err) => {
        console.error(`[File Read Error] ${err.message}`);
        report.textContent += `Error reading file: ${err.message}\n`;
    };
    reader.readAsText(csvFile);
});

// Initialize TinyMCE
tinymce.init({
    selector: '#editor',
    height: 300,
    plugins: 'link image',
    toolbar: 'undo redo | bold italic | link image',
    images_upload_handler: (blobInfo, success, failure) => {
        const reader = new FileReader();
        reader.onload = () => success(reader.result);
        reader.readAsDataURL(blobInfo.blob());
    },
});