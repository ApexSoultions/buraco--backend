import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

/** Personal room every authenticated socket joins on connect. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

@Injectable()
export class SocketService {
  private server: Server;

  setServer(server: Server) {
    this.server = server;
  }

  emitToRoom(room: string, event: string, data: unknown) {
    this.server?.to(room).emit(event, data);
  }

  /** Emit to each user's personal `user:<id>` room — reaches them wherever they are in the app. */
  emitToUsers(userIds: string[], event: string, data: unknown) {
    if (!this.server || userIds.length === 0) return;
    this.server.to(userIds.map(userRoom)).emit(event, data);
  }

  /** Emit to every connected socket (admin broadcasts). */
  emitToAll(event: string, data: unknown) {
    this.server?.emit(event, data);
  }

  /**
   * Disconnects every socket of this player (e.g. just banned). Uses `session:kicked`, which
   * the game already handles (it is also sent when the account logs in on another phone).
   */
  kickUser(userId: string, reason: string) {
    if (!this.server) return;
    this.server.to(userRoom(userId)).emit('session:kicked', { reason });
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  async emitPerPlayer(room: string, event: string, dataFn: (userId: string) => Promise<unknown>) {
    if (!this.server) return;
    const sockets = await this.server.in(room).fetchSockets();
    await Promise.all(
      sockets.map(async (s) => {
        const userId = s.data.userId as string;
        if (!userId) return;
        try {
          s.emit(event, await dataFn(userId));
        } catch {
          // Socket disconnected — reconnect will sync
        }
      }),
    );
  }
}
