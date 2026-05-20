import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameGateway } from './game.gateway';
import { Socket, Server } from 'socket.io';

describe('GameGateway', () => {
  let gateway: GameGateway;
  let mockSocket: any;
  let mockServer: any;

  beforeEach(() => {
    gateway = new GameGateway();

    // Mock de Socket.io Socket
    mockSocket = {
      id: 'socket-id-123',
      join: vi.fn(),
      emit: vi.fn(),
      to: vi.fn().mockReturnThis(),
    };

    // Mock de Socket.io Server
    mockServer = {
      to: vi.fn().mockReturnThis(),
      emit: vi.fn(),
      sockets: {
        sockets: new Map<string, any>()
      }
    };
    mockServer.sockets.sockets.set('socket-id-123', mockSocket);

    gateway.server = mockServer as unknown as Server;
  });

  describe('create-room', () => {
    it('should create a room and set client as host', () => {
      gateway.handleCreateRoom(mockSocket as unknown as Socket, {
        id: 'host-id',
        name: 'Alice',
      });

      // Debe haber 1 sala creada
      const roomsMap = (gateway as any).rooms as Map<string, any>;
      expect(roomsMap.size).toBe(1);

      // Obtener la clave generada
      const code = Array.from(roomsMap.keys())[0];
      expect(code.length).toBe(4);

      const room = roomsMap.get(code);
      expect(room.players.length).toBe(1);
      expect(room.players[0].name).toBe('Alice');
      expect(room.players[0].isHost).toBe(true);
      expect(room.status).toBe('lobby');

      // Validar llamadas de socket
      expect(mockSocket.join).toHaveBeenCalledWith(code);
      expect(mockSocket.emit).toHaveBeenCalledWith('room-state', expect.any(Object));
    });
  });

  describe('join-room', () => {
    let roomCode: string;

    beforeEach(() => {
      // Crear una sala primero para los tests de unirse
      gateway.handleCreateRoom(mockSocket as unknown as Socket, {
        id: 'host-id',
        name: 'Alice',
      });
      const roomsMap = (gateway as any).rooms as Map<string, any>;
      roomCode = Array.from(roomsMap.keys())[0];
    });

    it('should allow other players to join', () => {
      const secondSocket = {
        id: 'socket-id-456',
        join: vi.fn(),
        emit: vi.fn(),
      } as unknown as Socket;

      gateway.handleJoinRoom(secondSocket, {
        code: roomCode,
        player: { id: 'player-2', name: 'Bob' },
      });

      const roomsMap = (gateway as any).rooms as Map<string, any>;
      const room = roomsMap.get(roomCode);

      expect(room.players.length).toBe(2);
      expect(room.players[1].name).toBe('Bob');
      expect(room.players[1].isHost).toBe(false);

      expect(secondSocket.join).toHaveBeenCalledWith(roomCode);
      expect(mockServer.to).toHaveBeenCalledWith(roomCode);
    });

    it('should refuse to join if room does not exist', () => {
      const secondSocket = {
        id: 'socket-id-456',
        join: vi.fn(),
        emit: vi.fn(),
      } as unknown as Socket;

      gateway.handleJoinRoom(secondSocket, {
        code: 'XXXX',
        player: { id: 'player-2', name: 'Bob' },
      });

      expect(secondSocket.emit).toHaveBeenCalledWith('error-msg', 'SALA_NO_ENCONTRADA');
      expect(secondSocket.join).not.toHaveBeenCalled();
    });

    it('should refuse to join if room is full (max 12)', () => {
      const roomsMap = (gateway as any).rooms as Map<string, any>;
      const room = roomsMap.get(roomCode);

      // Rellenar la sala con 11 jugadores artificiales (12 en total con la anfitriona)
      for (let i = 2; i <= 12; i++) {
        room.players.push({
          id: `player-${i}`,
          name: `Player ${i}`,
          isImpostor: false,
          hasSeenRole: false,
          isEliminated: false,
          socketId: `socket-id-${i}`,
          status: 'active'
        });
      }

      const extraSocket = {
        id: 'socket-id-extra',
        join: vi.fn(),
        emit: vi.fn(),
      } as unknown as Socket;

      gateway.handleJoinRoom(extraSocket, {
        code: roomCode,
        player: { id: 'player-13', name: 'Charlie' },
      });

      expect(extraSocket.emit).toHaveBeenCalledWith('error-msg', 'SALA_LLENA');
      expect(room.players.length).toBe(12);
    });
  });

  describe('start-game', () => {
    let roomCode: string;

    beforeEach(() => {
      gateway.handleCreateRoom(mockSocket as unknown as Socket, {
        id: 'host-id',
        name: 'Alice',
      });
      const roomsMap = (gateway as any).rooms as Map<string, any>;
      roomCode = Array.from(roomsMap.keys())[0];

      // Configurar palabras en settings
      const room = roomsMap.get(roomCode);
      room.settings.words = [{ word: 'Secret', hint: 'Clue', fakeWord: 'Fake' }];

      // Agregar dos jugadores más para cumplir el mínimo de 3
      room.players.push({
        id: 'player-2',
        name: 'Bob',
        isImpostor: false,
        hasSeenRole: false,
        isEliminated: false,
        socketId: 'socket-id-456',
        status: 'active'
      });
      mockServer.sockets.sockets.set('socket-id-456', { emit: vi.fn() });

      room.players.push({
        id: 'player-3',
        name: 'Charlie',
        isImpostor: false,
        hasSeenRole: false,
        isEliminated: false,
        socketId: 'socket-id-789',
        status: 'active'
      });
      mockServer.sockets.sockets.set('socket-id-789', { emit: vi.fn() });
    });

    it('should assign roles and start the game', () => {
      gateway.handleStartGame(mockSocket as unknown as Socket, { code: roomCode });

      const roomsMap = (gateway as any).rooms as Map<string, any>;
      const room = roomsMap.get(roomCode);

      expect(room.status).toBe('reveal');
      expect(room.secretWord).toEqual({ word: 'Secret', hint: 'Clue', fakeWord: 'Fake' });

      // Debe haber exactamente 1 impostor
      const impostors = room.players.filter((p: any) => p.isImpostor);
      expect(impostors.length).toBe(1);
    });
  });
});
