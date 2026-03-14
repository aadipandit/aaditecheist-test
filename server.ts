import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Request logging middleware
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  
  // Ensure data directory exists
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  // Serve newly created HTML files from the root
  app.use((req, res, next) => {
    if (req.url.endsWith('.html') && req.method === 'GET') {
      const filePath = path.join(process.cwd(), req.url);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
    }
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // CORS Middleware (Allow requests from GitHub Pages for testing)
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // API Route to save generated pages and metadata
  app.post("/api/save-page", (req, res) => {
    console.log("Received save-page request:", req.body.filename);
    const { filename, content, itemData } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ error: "Filename and content are required." });
    }

    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
    const finalFilename = safeFilename.endsWith('.html') ? safeFilename : `${safeFilename}.html`;
    const filePath = path.join(process.cwd(), finalFilename);

    try {
      fs.writeFileSync(filePath, content);
      
      // Save metadata if provided (for comparisons/lists/reviews)
      if (itemData) {
        const metadataPath = path.join(dataDir, `${safeFilename}.json`);
        // Ensure pageType is included
        fs.writeFileSync(metadataPath, JSON.stringify({
          ...itemData,
          filename: finalFilename,
          updatedAt: new Date().toISOString()
        }, null, 2));
      }

      console.log(`File saved: ${finalFilename}`);
      res.json({ success: true, url: `/${finalFilename}` });
    } catch (error) {
      console.error("Error saving file:", error);
      res.status(500).json({ error: "Failed to save file." });
    }
  });

  // API Route to list all items with metadata
  app.get("/api/list-items", (req, res) => {
    try {
      const files = fs.readdirSync(dataDir);
      const items = files.filter(file => file.endsWith('.json')).map(file => {
        const content = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
        return {
          id: file.replace('.json', ''),
          name: content.model ? `${content.brand} ${content.model}` : content.name,
          data: content
        };
      });
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: "Failed to list items" });
    }
  });

  // API Route to push to GitHub
  app.post("/api/push-to-github", async (req, res) => {
    const { filename, content, commitMessage } = req.body;
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_USERNAME;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!token || !owner || !repo) {
      return res.status(400).json({ 
        success: false, 
        error: "GitHub configuration missing. Please add GITHUB_TOKEN, GITHUB_USERNAME, and GITHUB_REPO to AI Studio Settings." 
      });
    }

    const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
    const finalFilename = safeFilename.endsWith('.html') ? safeFilename : `${safeFilename}.html`;
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${finalFilename}`;

    try {
      // Check if file exists to get its SHA (required for updates)
      let sha;
      console.log(`Checking if file exists: ${url}`);
      const getResponse = await fetch(url, {
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'AI-Studio-App'
        }
      });
      
      if (getResponse.ok) {
        const fileData = await getResponse.json();
        sha = fileData.sha;
        console.log(`File exists, SHA: ${sha}`);
      } else if (getResponse.status !== 404) {
        const errData = await getResponse.json();
        console.error("GitHub GET Error:", errData);
        return res.status(getResponse.status).json({ success: false, error: errData.message || "GitHub API error" });
      }

      // Push to GitHub
      console.log(`Pushing to GitHub: ${url}`);
      const pushResponse = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'AI-Studio-App'
        },
        body: JSON.stringify({
          message: commitMessage || `Add ${finalFilename} review page`,
          content: Buffer.from(content).toString('base64'),
          sha: sha,
          branch: branch
        })
      });

      if (!pushResponse.ok) {
        const errorData = await pushResponse.json();
        console.error("GitHub PUT Error:", errorData);
        throw new Error(errorData.message || "GitHub API error");
      }

      const result = await pushResponse.json();
      res.json({ 
        success: true, 
        url: `https://${owner}.github.io/${repo}/${finalFilename}`,
        githubUrl: result.content.html_url
      });
    } catch (error) {
      console.error("GitHub Push Error:", error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Failed to push to GitHub" });
    }
  });

  // API Route to list all generated pages
  app.get("/api/list-pages", (req, res) => {
    try {
      const files = fs.readdirSync(process.cwd());
      const htmlFiles = files.filter(file => 
        file.endsWith('.html') && 
        file !== 'index.html' && 
        file !== 'leader.html' &&
        file !== '404.html'
      ).map(file => {
        const stats = fs.statSync(path.join(process.cwd(), file));
        return {
          name: file,
          url: `/${file}`,
          mtime: stats.mtime
        };
      });
      res.json(htmlFiles);
    } catch (error) {
      console.error("Error listing pages:", error);
      res.status(500).json({ error: "Failed to list pages" });
    }
  });

  // API Route to get page content for editing
  app.get("/api/get-page", (req, res) => {
    const { filename } = req.query;
    if (!filename) return res.status(400).json({ error: "Filename required" });
    
    const filePath = path.join(process.cwd(), String(filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ content });
    } catch (error) {
      res.status(500).json({ error: "Failed to read file" });
    }
  });

  // API Route to delete a page
  app.delete("/api/delete-page", (req, res) => {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename required" });

    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    try {
      fs.unlinkSync(filePath);
      // Also delete metadata if it exists
      const metadataPath = path.join(dataDir, `${filename.replace('.html', '')}.json`);
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete file" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
