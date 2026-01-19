// Simple static file server for the client
const express = require('express');
const path = require('path');
const app = express();

// Serve static files from the client directory
app.use(express.static(path.join(__dirname, '../client')));

const PORT = process.env.CLIENT_PORT || 8080;
app.listen(PORT, () => {
  console.log(`Client server running on http://localhost:${PORT}`);
});
