import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { google } from 'googleapis';
import { config } from 'dotenv';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// Add root route handler
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>CodeCraft AI Backend</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background-color: #f5f5f5;
          }
          .container {
            text-align: center;
            padding: 2rem;
            background-color: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .status {
            color: #4CAF50;
            font-size: 1.2rem;
            margin-bottom: 1rem;
          }
          .info {
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>CodeCraft AI Backend</h1>
          <div class="status">✅ Server is running</div>
          <p class="info">Server Time: ${new Date().toLocaleString()}</p>
          <p class="info">Environment: ${process.env.NODE_ENV || 'development'}</p>
        </div>
      </body>
    </html>
  `);
});

const WORKSPACE_DIR = process.env.NODE_ENV === 'production'
    ? '/tmp/workspace'
    : join(__dirname, '..', 'workspace');
const activeProcesses = new Map();

// Ensure workspace directory exists
try {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
} catch (error) {
    console.error('Error creating workspace directory:', error);
}

// Function to kill a process and its children
const killProcess = async (pid) => {
    try {
        if (process.platform === 'win32') {
            // On Windows, use taskkill to kill the process and its children
            spawn('taskkill', ['/pid', pid, '/t', '/f']);
        } else {
            // On Unix-like systems, use kill
            process.kill(pid, 'SIGTERM');
        }
    } catch (error) {
        console.error(`Error killing process ${pid}:`, error);
    }
};

// Function to recursively delete a directory
const deleteDirectory = async (dirPath) => {
    try {
        // First, try to kill any processes that might be using the directory
        const processes = Array.from(activeProcesses.values());
        for (const process of processes) {
            if (process.cwd.includes(dirPath)) {
                await killProcess(process.pid);
            }
        }

        // Wait a moment for processes to terminate
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Now try to delete the directory
        await fs.rm(dirPath, { recursive: true, force: true });
    } catch (error) {
        console.error(`Error deleting directory ${dirPath}:`, error);
        throw error;
    }
};

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'command') {
                const command = data.command;
                const cwd = WORKSPACE_DIR;

                // Create a new process
                const childProcess = spawn(command, [], {
                    shell: true,
                    cwd,
                    env: {
                        ...process.env,
                        FORCE_COLOR: '1',
                        npm_config_audit: 'false'
                    }
                });

                // Store the process
                activeProcesses.set(childProcess.pid, {
                    process: childProcess,
                    cwd,
                    ws
                });

                // Handle process output
                childProcess.stdout.on('data', (data) => {
                    const output = data.toString();
                    ws.send(JSON.stringify({
                        type: 'output',
                        content: output,
                        command: command // Include the command for frontend processing
                    }));
                });

                childProcess.stderr.on('data', (data) => {
                    const error = data.toString();
                    ws.send(JSON.stringify({
                        type: 'error',
                        content: error,
                        command: command
                    }));
                });

                childProcess.on('close', async (code) => {
                    activeProcesses.delete(childProcess.pid);

                    // If it's a create-react-app command, notify frontend to refresh files
                    if (command.includes('create-react-app')) {
                        ws.send(JSON.stringify({
                            type: 'commandComplete',
                            command: command,
                            code: code,
                            message: 'React app created successfully! You can now start editing the files.'
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            type: 'close',
                            code: code,
                            command: command
                        }));
                    }
                });

                childProcess.on('error', (error) => {
                    activeProcesses.delete(childProcess.pid);
                    ws.send(JSON.stringify({
                        type: 'error',
                        content: error.message,
                        command: command
                    }));
                });

            } else if (data.type === 'stop') {
                // Kill all active processes
                for (const [pid, process] of activeProcesses.entries()) {
                    await killProcess(pid);
                    activeProcesses.delete(pid);
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', content: error.message }));
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected');
        // Kill all processes associated with this connection
        for (const [pid, process] of activeProcesses.entries()) {
            if (process.ws === ws) {
                await killProcess(pid);
                activeProcesses.delete(pid);
            }
        }
    });
});

// File operations
app.get('/api/files/list', async (req, res) => {
    try {
        const { path = '' } = req.query;
        // Remove any leading slashes and workspace references from the path
        const cleanPath = path.replace(/^\/+/, '').replace(/^workspace\/+/, '');
        const targetPath = join(WORKSPACE_DIR, cleanPath);

        // Ensure the target path is within the workspace directory
        if (!targetPath.startsWith(WORKSPACE_DIR)) {
            return res.status(403).json({ error: 'Access denied: Path is outside workspace' });
        }

        const files = await fs.readdir(targetPath, { withFileTypes: true });
        const fileList = await Promise.all(files.map(async (file) => {
            const filePath = join(targetPath, file.name);
            const stats = await fs.stat(filePath);
            return {
                name: file.name,
                path: filePath.replace(WORKSPACE_DIR, '').replace(/\\/g, '/'),
                type: file.isDirectory() ? 'directory' : 'file',
                size: stats.size,
                modified: stats.mtime
            };
        }));
        res.json(fileList);
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/files/read', async (req, res) => {
    try {
        // Remove any leading slashes and workspace references from the path
        const cleanPath = (req.query.path || '').replace(/^\/+/, '').replace(/^workspace\/+/, '');
        const filePath = join(WORKSPACE_DIR, cleanPath);

        // Ensure the target path is within the workspace directory
        if (!filePath.startsWith(WORKSPACE_DIR)) {
            return res.status(403).json({ error: 'Access denied: Path is outside workspace' });
        }

        const content = await fs.readFile(filePath, 'utf-8');
        res.json({ content });
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/files/write', async (req, res) => {
    try {
        // Remove any leading slashes and workspace references from the path
        const cleanPath = req.body.path.replace(/^\/+/, '').replace(/^workspace\/+/, '');
        const filePath = join(WORKSPACE_DIR, cleanPath);

        // Ensure the target path is within the workspace directory
        if (!filePath.startsWith(WORKSPACE_DIR)) {
            return res.status(403).json({ error: 'Access denied: Path is outside workspace' });
        }

        await fs.writeFile(filePath, req.body.content, 'utf-8');
        res.json({ success: true });
    } catch (error) {
        console.error('Error writing file:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/files/delete', async (req, res) => {
    try {
        // Remove any leading slashes and workspace references from the path
        const cleanPath = req.body.path.replace(/^\/+/, '').replace(/^workspace\/+/, '');
        const targetPath = join(WORKSPACE_DIR, cleanPath);

        // Ensure the target path is within the workspace directory
        if (!targetPath.startsWith(WORKSPACE_DIR)) {
            return res.status(403).json({ error: 'Access denied: Path is outside workspace' });
        }

        await deleteDirectory(targetPath);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: error.message });
    }
});

// AI code processing
app.post('/api/process-code', async (req, res) => {
    try {
        const { code, prompt } = req.body;
        const genAI = new google.ai.generativelanguage.GenerativeLanguage({
            apiKey: process.env.GEMINI_API_KEY
        });

        const result = await genAI.models.generateContent({
            model: 'gemini-pro',
            contents: [{
                parts: [{
                    text: `Code:\n${code}\n\nPrompt: ${prompt}`
                }]
            }]
        });

        res.json({ response: result.data.candidates[0].content.parts[0].text });
    } catch (error) {
        console.error('Error processing code:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 
