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

  // Ensure subdirectories exist for generated content
  const subDirs = ['comparison', 'best-of', 'budget', 'segment', 'mobile', 'laptop'];
  subDirs.forEach(dir => {
    const dirPath = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      console.log(`Creating directory: ${dirPath}`);
      fs.mkdirSync(dirPath, { recursive: true });
    }
  });

  // Serve newly created HTML files from the root and subdirectories
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
    res.json({ 
      status: "ok", 
      time: new Date().toISOString(),
      cwd: process.cwd(),
      folders: fs.readdirSync(process.cwd()).filter(f => fs.statSync(f).isDirectory())
    });
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
    const { filename, content, itemData, folder } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ error: "Filename and content are required." });
    }

    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
    const finalFilename = safeFilename.endsWith('.html') ? safeFilename : `${safeFilename}.html`;
    
    // Determine target directory
    let targetDir = process.cwd();
    if (folder && ['comparison', 'best-of', 'budget', 'segment', 'mobile', 'laptop'].includes(folder)) {
      targetDir = path.resolve(process.cwd(), folder);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    }
    
    const filePath = path.join(targetDir, finalFilename);
    const relativeUrl = folder ? `/${folder}/${finalFilename}` : `/${finalFilename}`;

    try {
      fs.writeFileSync(filePath, content);
      
      // Save metadata if provided (for comparisons/lists/reviews)
      if (itemData) {
        const metadataPath = path.join(dataDir, `${safeFilename}.json`);
        // Ensure pageType is included
        fs.writeFileSync(metadataPath, JSON.stringify({
          ...itemData,
          filename: finalFilename,
          folder: folder || '',
          url: relativeUrl,
          updatedAt: new Date().toISOString()
        }, null, 2));
      }

      console.log(`File saved: ${filePath}`);
      res.json({ success: true, url: relativeUrl });
    } catch (error) {
      console.error("Error saving file:", error);
      res.status(500).json({ error: "Failed to save file." });
    }
  });

  // API Route to list all items with metadata
  app.get("/api/list-items", (req, res) => {
    try {
      const items = getItemsMetadata();
      res.json(items);
    } catch (error) {
      res.status(500).json({ error: "Failed to list items" });
    }
  });

  function getItemsMetadata() {
    const files = fs.readdirSync(dataDir);
    const items = files.filter(file => file.endsWith('.json') && file !== 'data.json').map(file => {
      const content = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
      return {
        id: file.replace('.json', ''),
        name: content.model ? `${content.brand} ${content.model}` : content.name,
        data: content
      };
    });
    
    // Sort by updatedAt descending
    items.sort((a, b) => {
      const dateA = new Date(a.data.updatedAt || 0);
      const dateB = new Date(b.data.updatedAt || 0);
      return dateB.getTime() - dateA.getTime();
    });

    return items;
  }

  async function pushFileToGitHub(filename, content, commitMessage) {
    const token = process.env.GITHUB_TOKEN;
    const owner = process.env.GITHUB_USERNAME;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';

    if (!token || !owner || !repo) {
      throw new Error("GitHub configuration missing.");
    }

    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`;

    // Check if file exists to get its SHA
    let sha;
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
    }

    // Push to GitHub
    const pushResponse = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AI-Studio-App'
      },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(content).toString('base64'),
        sha: sha,
        branch: branch
      })
    });

    if (!pushResponse.ok) {
      const errorData = await pushResponse.json();
      throw new Error(errorData.message || "GitHub API error");
    }

    return await pushResponse.json();
  }

  // API Route to push to GitHub
  app.post("/api/push-to-github", async (req, res) => {
    const { filename, content, commitMessage } = req.body;
    
    if (!filename || !content) {
      return res.status(400).json({ error: "Filename and content are required." });
    }

    try {
      // 1. Push the HTML page
      const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
      const finalFilename = safeFilename.endsWith('.html') ? safeFilename : `${safeFilename}.html`;
      
      const pushResult = await pushFileToGitHub(finalFilename, content, commitMessage || `Add ${finalFilename} review page`);

      // 2. Update and push data.json
      const items = getItemsMetadata();
      const dataJsonContent = JSON.stringify(items, null, 2);
      fs.writeFileSync(path.join(process.cwd(), 'data.json'), dataJsonContent);
      
      try {
        await pushFileToGitHub('data.json', dataJsonContent, "Update data.json metadata");
      } catch (dataErr) {
        console.error("Failed to push data.json:", dataErr);
        // We don't fail the whole request if data.json fails, but it's not ideal
      }

      const owner = process.env.GITHUB_USERNAME;
      const repo = process.env.GITHUB_REPO;
      const customDomain = process.env.CUSTOM_DOMAIN;
      let baseUrl = `https://${owner}.github.io/${repo}`;
      
      if (customDomain) {
        baseUrl = `https://${customDomain}`;
      } else if (repo === `${owner}.github.io`) {
        baseUrl = `https://${owner}.github.io`;
      }
      
      res.json({ 
        success: true, 
        url: `${baseUrl}/${finalFilename}`,
        githubUrl: pushResult.content.html_url
      });
    } catch (error) {
      console.error("GitHub Push Error:", error);
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Failed to push to GitHub" });
    }
  });

  // API Route to list all generated pages (including subdirectories)
  app.get("/api/list-pages", (req, res) => {
    try {
      const folders = ['', 'comparison', 'best-of', 'budget', 'segment', 'mobile', 'laptop'];
      let allPages: any[] = [];

      folders.forEach(folder => {
        const dirPath = path.join(process.cwd(), folder);
        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);
          const htmlFiles = files.filter(file => 
            file.endsWith('.html') && 
            !['index.html', 'leader.html', '404.html', 'comparisons.html', 'best-of-5.html', 'segments.html', 'budget.html'].includes(file)
          ).map(file => {
            const stats = fs.statSync(path.join(dirPath, file));
            return {
              name: file,
              folder: folder,
              url: folder ? `/${folder}/${file}` : `/${file}`,
              mtime: stats.mtime
            };
          });
          allPages = [...allPages, ...htmlFiles];
        }
      });

      // Sort by modified time descending
      allPages.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      
      res.json(allPages);
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
    const { filename, folder } = req.body;
    if (!filename) return res.status(400).json({ error: "Filename required" });

    let filePath = path.join(process.cwd(), filename);
    if (folder && ['comparison', 'best-of', 'budget', 'segment', 'mobile', 'laptop'].includes(folder)) {
      filePath = path.join(process.cwd(), folder, filename);
    }
    
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      // Also delete metadata if it exists
      const metadataPath = path.join(dataDir, `${filename.replace('.html', '')}.json`);
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Delete Error:", error);
      res.status(500).json({ error: "Failed to delete page" });
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
