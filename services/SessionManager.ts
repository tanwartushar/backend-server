import type { WebSocket } from 'ws';
import type { PrismaClient } from '@prisma/client';

function debounce(func: Function, wait: number) {
  let timeout: NodeJS.Timeout | null = null;
  return (...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const GRACE_PERIOD = 2 * 60 * 1000; // 2 minutes
const DEBOUNCE_WAIT = 2000; // 2 seconds

interface ActiveSessionData {
  connections: Set<WebSocket>;
  gracePeriodTimeout?: NodeJS.Timeout | undefined;
  inactivityTimeout?: NodeJS.Timeout | undefined;
  cleanup?: (() => void) | undefined;
  ydoc: any;
}

const activeSessions = new Map<string, ActiveSessionData>();

export class SessionManager {
  static prisma: PrismaClient;
  static Yjs: any;

  static init(prismaClient: PrismaClient, yjsLib: any) {
    this.prisma = prismaClient;
    this.Yjs = yjsLib;
  }

  static handleConnection(ws: WebSocket, docName: string, ydoc: any) {
    if (!this.prisma) throw new Error("SessionManager not initialized with prisma!");

    if (!activeSessions.has(docName)) {
      activeSessions.set(docName, { connections: new Set(), ydoc });
      
      const sessionData = activeSessions.get(docName)!;

      const debouncedSave = debounce(async () => {
        const state = this.Yjs.encodeStateAsUpdate(ydoc);
        try {
          // Because we securely create the session on match via POST /sessions, it exists!
          await this.prisma.session.update({
            where: { id: docName },
            data: { docState: Buffer.from(state) }
          });
        } catch (e) {
          // Ignore failures for docs that might be terminated already
        }
      }, DEBOUNCE_WAIT);

      const handleUpdate = () => {
        debouncedSave();
        this.resetInactivityTimer(docName);
      };

      ydoc.on('update', handleUpdate);
      this.resetInactivityTimer(docName);

      sessionData.cleanup = () => {
        ydoc.off('update', handleUpdate);
      };
    }

    const sessionData = activeSessions.get(docName)!;
    sessionData.connections.add(ws);

    // If a user connects, clear any ongoing disconnection grace period!
    if (sessionData.gracePeriodTimeout) {
      clearTimeout(sessionData.gracePeriodTimeout);
      sessionData.gracePeriodTimeout = undefined;
      console.log(`[SessionManager] ${docName}: Grace period cleared, user rejoined.`);
    }

    ws.on('close', () => {
      sessionData.connections.delete(ws);
      console.log(`[SessionManager] ${docName}: Client disconnected. Remaining: ${sessionData.connections.size}`);
      
      if (sessionData.connections.size < 2) {
        if (!sessionData.gracePeriodTimeout) {
          console.log(`[SessionManager] ${docName}: Starting 2-minute disconnect grace period.`);
          sessionData.gracePeriodTimeout = setTimeout(() => {
            this.terminateSession(docName, 'Peer disconnected and did not return in time.');
          }, GRACE_PERIOD);
        }
      }
    });
  }

  static resetInactivityTimer(docName: string) {
    const sessionData = activeSessions.get(docName);
    if (!sessionData) return;

    if (sessionData.inactivityTimeout) {
      clearTimeout(sessionData.inactivityTimeout);
    }

    sessionData.inactivityTimeout = setTimeout(() => {
      console.log(`[SessionManager] ${docName}: 30 minutes of inactivity. Terminating.`);
      this.terminateSession(docName, 'Session timed out due to 30 minutes of inactivity.');
    }, INACTIVITY_TIMEOUT);
  }

  static async terminateSession(docName: string, reason: string) {
    const sessionData = activeSessions.get(docName);
    console.log(`[SessionManager] Terminating session ${docName}. Reason: ${reason}`);

    if (sessionData) {
      if (sessionData.gracePeriodTimeout) clearTimeout(sessionData.gracePeriodTimeout);
      if (sessionData.inactivityTimeout) clearTimeout(sessionData.inactivityTimeout);
      if (sessionData.cleanup) sessionData.cleanup();

      // Transmit the termination via the shared Y.Doc 'sys' map.
      // This allows the frontend to instantly react to the termination payload.
      sessionData.ydoc.getMap('sys').set('status', 'terminated');
      sessionData.ydoc.getMap('sys').set('reason', reason);

      for (const socket of sessionData.connections) {
        // Code 4000 denotes a custom closure event that the frontend can intercept
        socket.close(4000, reason); 
      }
      activeSessions.delete(docName);
    }

    try {
      await this.prisma.session.update({
        where: { id: docName },
        data: { status: 'terminated', terminatedAt: new Date() }
      });
    } catch (e) {
      console.error(`[SessionManager] Failed to update DB on termination for ${docName}`, e);
    }
  }
}
