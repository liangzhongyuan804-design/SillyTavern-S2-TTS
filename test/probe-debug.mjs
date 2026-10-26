import net from 'node:net';

const HOST = '127.0.0.1';
const PORT = 3030;

await new Promise((resolve) => {
    const socket = net.connect(PORT, HOST);
    socket.on('connect', () => {
        console.log(`TCP ${PORT}: CONNECTED`);
        socket.destroy();
        resolve();
    });
    socket.on('error', (error) => {
        console.log(`TCP ${PORT}: ${error.code}`);
        resolve();
    });
});

for (const path of ['/generate', '//generate']) {
    try {
        const response = await fetch(`http://${HOST}:${PORT}${path}`, {
            method: 'POST',
            body: new FormData(),
        });
        const text = await response.text();
        console.log(`${path} -> ${response.status} ${JSON.stringify(text.slice(0, 300))}`);
    } catch (error) {
        console.log(`${path} -> ERR ${error.message} ${error.cause?.message ?? ''}`);
    }
}
