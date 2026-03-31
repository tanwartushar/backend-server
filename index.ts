import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { setupWSConnection, setPersistence } from 'y-websocket/bin/utils';
import cors from 'cors';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Yjs = require('yjs');

const PORT = process.env.PORT || 3004;
const app = express();

app.use(cors());
app.use(express.json());

// In-memory persistence for documents
const docs: Record<string, any> = {};

setPersistence({
  bindState: async (docName: string, ydoc: any) => {
    if (docs[docName]) {
      Yjs.applyUpdate(ydoc, docs[docName].toBinary());
    }
  },
  writeState: async (docName: string, ydoc: any) => {
    docs[docName] = ydoc;
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (conn: any, req: any, { docName }: any) => {
  console.log(`[WS] Connected to document: ${docName}`);
  setupWSConnection(conn, req, { docName, gc: true });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/collaboration/ws/')) {
    const docName = url.pathname.split('/').pop() || 'default';
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { docName });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});