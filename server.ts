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

  // API Route to save generated pages
  app.post("/api/save-page", (req, res) => {
    console.log("Received save-page request:", req.body.filename);
    const { filename, content } = req.body;

    if (!filename || !content) {
      return res.status(400).json({ error: "Filename and content are required." });
    }

    // Sanitize filename to prevent directory traversal
    const safeFilename = path.basename(filename).replace(/[^a-z0-9.-]/gi, '_');
    const finalFilename = safeFilename.endsWith('.html') ? safeFilename : `${safeFilename}.html`;
    const filePath = path.join(process.cwd(), finalFilename);

    try {
      fs.writeFileSync(filePath, content);
      console.log(`File saved: ${finalFilename}`);
      res.json({ success: true, url: `/${finalFilename}` });
    } catch (error) {
      console.error("Error saving file:", error);
      res.status(500).json({ error: "Failed to save file." });
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
