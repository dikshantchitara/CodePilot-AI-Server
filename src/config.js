const path = require('path');

// Get the absolute path to the workspace directory
const workspacePath = path.join(__dirname, '..', 'workspace');

// Debug log to verify the workspace path
console.log('Workspace path:', workspacePath);

module.exports = {
    workspacePath
}; 