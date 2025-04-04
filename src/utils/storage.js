import { put, list, del } from "@vercel/blob";
import fs from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOCAL_WORKSPACE_DIR = join(__dirname, '..', '..', 'workspace');

class StorageManager {
    constructor() {
        this.isProduction = process.env.NODE_ENV === 'production';
    }

    async initialize() {
        if (!this.isProduction) {
            try {
                await fs.mkdir(LOCAL_WORKSPACE_DIR, { recursive: true });
            } catch (error) {
                console.error('Error creating local workspace directory:', error);
            }
        }
    }

    async writeFile(path, content) {
        if (this.isProduction) {
            const { url } = await put(path, content, {
                access: 'public',
                token: process.env.WORKSPACE_READ_WRITE_TOKEN
            });
            return url;
        } else {
            const fullPath = join(LOCAL_WORKSPACE_DIR, path);
            await fs.mkdir(dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
            return fullPath;
        }
    }

    async readFile(path) {
        if (this.isProduction) {
            const response = await fetch(`https://public.blob.vercel-storage.com/${path}`);
            if (!response.ok) throw new Error('File not found');
            return await response.text();
        } else {
            const fullPath = join(LOCAL_WORKSPACE_DIR, path);
            return await fs.readFile(fullPath, 'utf-8');
        }
    }

    async deleteFile(path) {
        if (this.isProduction) {
            await del(path, {
                token: process.env.WORKSPACE_READ_WRITE_TOKEN
            });
        } else {
            const fullPath = join(LOCAL_WORKSPACE_DIR, path);
            await fs.unlink(fullPath);
        }
    }

    async listFiles(prefix = '') {
        if (this.isProduction) {
            const { blobs } = await list({
                token: process.env.WORKSPACE_READ_WRITE_TOKEN,
                prefix: prefix
            });
            return blobs.map(blob => ({
                name: blob.pathname,
                url: blob.url,
                size: blob.size,
                uploadedAt: blob.uploadedAt
            }));
        } else {
            const files = await fs.readdir(join(LOCAL_WORKSPACE_DIR, prefix), { withFileTypes: true });
            return await Promise.all(files.map(async file => {
                const fullPath = join(LOCAL_WORKSPACE_DIR, prefix, file.name);
                const stats = await fs.stat(fullPath);
                return {
                    name: join(prefix, file.name),
                    path: fullPath,
                    size: stats.size,
                    modified: stats.mtime
                };
            }));
        }
    }
}

export const storage = new StorageManager(); 
