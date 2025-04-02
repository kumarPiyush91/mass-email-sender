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
        const emails = csvData.split('\n').filter(line => line.trim()).length - 1; // Subtract header
        totalEmails.textContent = emails;

        const response = await fetch('/send-emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject, htmlContent, csvFile: csvData }),
        });

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
                    sentEmails.textContent = count; // Update sent count
                    report.textContent += `Sent to ${email}\n`;
                } else if (data.startsWith('Error')) {
                    const [_, count, email, ...errorParts] = data.split(':');
                    report.textContent += `Error sending to ${email}: ${errorParts.join(':')}\n`;
                } else if (data.startsWith('Completed')) {
                    const [_, sent, failed] = data.split(':');
                    report.textContent += `Completed! Sent: ${sent}, Failed: ${failed}\n`;
                } else if (data.startsWith('Total emails to send')) {
                    report.textContent += `${data}\n`;
                }
            }
            report.scrollTop = report.scrollHeight;
        }
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