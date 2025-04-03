const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { workspacePath } = require('../config');

// Helper function to get file type
const getFileType = async (filePath) => {
    try {
        const stats = await fs.stat(filePath);
        if (stats.isDirectory()) {
            return 'directory';
        }
        // Check if it's a hidden file (starts with .)
        if (path.basename(filePath).startsWith('.')) {
            return 'file';
        }
        return 'file';
    } catch (error) {
        console.error('Error getting file type:', error);
        return 'file';
    }
};

// Helper function to get file info
const getFileInfo = async (filePath) => {
    const stats = await fs.stat(filePath);
    const fileType = await getFileType(filePath);
    return {
        name: path.basename(filePath),
        path: path.relative(workspacePath, filePath).replace(/\\/g, '/'),
        type: fileType,
        size: stats.size,
        modified: stats.mtime
    };
};

// Helper function to get directory contents recursively
const getDirectoryContents = async (dirPath) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const contents = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = path.join(dirPath, entry.name);
            const fileInfo = await getFileInfo(entryPath);

            if (fileInfo.type === 'directory') {
                try {
                    const children = await fs.readdir(entryPath);
                    fileInfo.children = children.length > 0;
                } catch (error) {
                    fileInfo.children = false;
                }
            }

            return fileInfo;
        })
    );

    // Sort directories first, then files
    contents.sort((a, b) => {
        if (a.type === 'directory' && b.type === 'file') return -1;
        if (a.type === 'file' && b.type === 'directory') return 1;
        return a.name.localeCompare(b.name);
    });

    return contents;
};

// List files in a directory
router.get('/list', async (req, res) => {
    try {
        const { path: dirPath = '' } = req.query;
        const fullPath = path.join(workspacePath, dirPath);

        console.log('Listing directory:', fullPath); // Debug log
        console.log('Workspace path:', workspacePath); // Debug log
        console.log('Directory path:', dirPath); // Debug log

        // Check if path exists and is within workspace
        try {
            await fs.access(fullPath);
            const stats = await fs.stat(fullPath);
            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (error) {
            console.error('Directory access error:', error); // Debug log
            return res.status(404).json({ error: 'Directory not found' });
        }

        // Get directory contents
        const files = await getDirectoryContents(fullPath);
        res.json(files);
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Read file content
router.get('/read', async (req, res) => {
    try {
        const { path: filePath } = req.query;
        const fullPath = path.join(workspacePath, filePath);

        console.log('Reading file:', fullPath); // Debug log
        console.log('Workspace path:', workspacePath); // Debug log
        console.log('File path:', filePath); // Debug log

        // Check if file exists and is within workspace
        try {
            await fs.access(fullPath);
            const stats = await fs.stat(fullPath);
            if (stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is a directory' });
            }
        } catch (error) {
            console.error('File access error:', error); // Debug log
            return res.status(404).json({ error: 'File not found' });
        }

        // Read file content with proper encoding
        const content = await fs.readFile(fullPath, { encoding: 'utf8', flag: 'r' });
        console.log('File content length:', content.length); // Debug log

        res.json({
            content,
            path: filePath,
            name: path.basename(filePath)
        });
    } catch (error) {
        console.error('Error reading file:', error);
        res.status(500).json({ error: 'Failed to read file' });
    }
});

// Create new file or directory
router.post('/create', async (req, res) => {
    try {
        const { path: dirPath, name, type } = req.body;
        const fullPath = path.join(workspacePath, dirPath, name);

        // Check if parent directory exists
        try {
            await fs.access(path.dirname(fullPath));
        } catch (error) {
            return res.status(404).json({ error: 'Parent directory not found' });
        }

        if (type === 'directory') {
            await fs.mkdir(fullPath);
        } else {
            await fs.writeFile(fullPath, '');
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        res.status(500).json({ error: 'Failed to create file/directory' });
    }
});

// Delete file or directory
router.post('/delete', async (req, res) => {
    try {
        const { path: filePath } = req.body;
        const fullPath = path.join(workspacePath, filePath);

        // Check if file exists and is within workspace
        try {
            await fs.access(fullPath);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
            await fs.rm(fullPath, { recursive: true });
        } else {
            await fs.unlink(fullPath);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

module.exports = router; 