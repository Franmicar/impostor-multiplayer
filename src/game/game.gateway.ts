import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomState, Player, GameSettings } from './types';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Salas activas en memoria
  private rooms = new Map<string, RoomState>();
  // Control de desconexión temporal de 45 segundos por jugador
  private disconnectTimeouts = new Map<string, NodeJS.Timeout>();

  handleConnection(client: Socket) {
    console.log(`Cliente conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Cliente desconectado: ${client.id}`);
    
    // Buscar si el socket pertenecía a alguna sala activa
    for (const [code, room] of this.rooms.entries()) {
      const playerIndex = room.players.findIndex(p => p.socketId === client.id);
      if (playerIndex !== -1) {
        const player = room.players[playerIndex];
        player.status = 'away';
        player.socketId = undefined;

        console.log(`Jugador ${player.name} (${player.id}) está temporalmente desconectado de la sala ${code}`);
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));

        // Programar el timeout de 45 segundos para eliminación definitiva
        const timeoutKey = `${code}:${player.id}`;
        if (this.disconnectTimeouts.has(timeoutKey)) {
          clearTimeout(this.disconnectTimeouts.get(timeoutKey));
        }

        const timeout = setTimeout(() => {
          this.removePlayerPermanently(code, player.id);
        }, 45000); // 45 segundos

        this.disconnectTimeouts.set(timeoutKey, timeout);
        break;
      }
    }
  }

  @SubscribeMessage('create-room')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() hostData: { id: string; name: string; photoUrl?: string },
  ) {
    const code = this.generateRoomCode();
    const defaultSettings: GameSettings = {
      playerData: [],
      words: [],
      numImpostors: 1,
      numDetectives: 0,
      modeId: 'normal',
      gameTypeId: 'word',
      hints: 'all',
    };

    const hostPlayer: Player = {
      id: hostData.id,
      name: hostData.name,
      photoUrl: hostData.photoUrl,
      isImpostor: false,
      hasSeenRole: false,
      isEliminated: false,
      socketId: client.id,
      isHost: true,
      status: 'active',
    };

    const newRoom: RoomState = {
      code,
      settings: defaultSettings,
      players: [hostPlayer],
      status: 'lobby',
      secretWord: null,
      startingPlayerId: null,
      currentPlayerIndex: 0,
      eliminationsCount: 0,
      drawings: [],
    };

    this.rooms.set(code, newRoom);
    client.join(code);
    client.emit('room-state', this.sanitizeRoomState(newRoom));
    console.log(`Sala creada: ${code} por el anfitrión ${hostData.name}`);
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; player: { id: string; name: string; photoUrl?: string } },
  ) {
    const code = data.code?.toUpperCase();
    const room = this.rooms.get(code);

    if (!room) {
      client.emit('error-msg', 'SALA_NO_ENCONTRADA');
      return;
    }

    // Cancelar cualquier timeout de desconexión si es una reconexión
    const timeoutKey = `${code}:${data.player.id}`;
    if (this.disconnectTimeouts.has(timeoutKey)) {
      clearTimeout(this.disconnectTimeouts.get(timeoutKey));
      this.disconnectTimeouts.delete(timeoutKey);
    }

    const existingPlayer = room.players.find(p => p.id === data.player.id);

    if (existingPlayer) {
      // Reconexión exitosa del jugador existente
      existingPlayer.socketId = client.id;
      existingPlayer.status = 'active';
      client.join(code);
      console.log(`Jugador reconectado: ${existingPlayer.name} a la sala ${code}`);
      
      // Si el juego está activo, volver a enviarle su rol individual de manera segura
      if (room.status !== 'lobby') {
        this.sendIndividualRole(client, existingPlayer, room);
      }
    } else {
      // Unirse por primera vez
      if (room.players.length >= 12) {
        client.emit('error-msg', 'SALA_LLENA');
        return;
      }

      if (room.status !== 'lobby') {
        client.emit('error-msg', 'PARTIDA_YA_EMPEZADA');
        return;
      }

      const newPlayer: Player = {
        id: data.player.id,
        name: data.player.name,
        photoUrl: data.player.photoUrl,
        isImpostor: false,
        hasSeenRole: false,
        isEliminated: false,
        socketId: client.id,
        isHost: false,
        status: 'active',
      };

      room.players.push(newPlayer);
      client.join(code);
      console.log(`Jugador ${newPlayer.name} se unió a la sala ${code}`);
    }

    this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
  }

  @SubscribeMessage('sync-settings')
  handleSyncSettings(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; settings: GameSettings },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    // Solo el Host puede sincronizar la configuración
    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    room.settings = data.settings;
    this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));
  }

  @SubscribeMessage('start-game')
  handleStartGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    const activePlayers = room.players.filter(p => p.status === 'active');
    if (activePlayers.length < 3) {
      client.emit('error-msg', 'MINIMO_3_JUGADORES');
      return;
    }

    const { words, numImpostors, numDetectives, modeId } = room.settings;
    if (!words || words.length === 0) {
      client.emit('error-msg', 'LISTA_PALABRAS_VACIA');
      return;
    }

    // Seleccionar palabra al azar
    const randomWordObj = words[Math.floor(Math.random() * words.length)];
    room.secretWord = randomWordObj;

    // Resetear roles en todos los jugadores
    room.players.forEach(p => {
      p.isImpostor = false;
      p.isDetective = false;
      p.hasSeenRole = false;
      p.isEliminated = false;
    });

    // Asignar impostores de forma aleatoria (exclusivamente en el servidor)
    let assignedImpostors = 0;
    const finalImpostorsCount = modeId === 'chaos' 
      ? Math.floor(Math.random() * (activePlayers.length + 1)) 
      : numImpostors;

    while (assignedImpostors < finalImpostorsCount && assignedImpostors < activePlayers.length) {
      const randomIndex = Math.floor(Math.random() * room.players.length);
      const player = room.players[randomIndex];
      if (player.status === 'active' && !player.isImpostor) {
        player.isImpostor = true;
        assignedImpostors++;
      }
    }

    // Asignar detectives (no pueden ser impostores)
    let assignedDetectives = 0;
    while (assignedDetectives < numDetectives && (assignedImpostors + assignedDetectives) < activePlayers.length) {
      const randomIndex = Math.floor(Math.random() * room.players.length);
      const player = room.players[randomIndex];
      if (player.status === 'active' && !player.isImpostor && !player.isDetective) {
        player.isDetective = true;
        assignedDetectives++;
      }
    }

    // Determinar jugador inicial de forma aleatoria
    const activeList = room.players.filter(p => p.status === 'active');
    const startingPlayer = activeList[Math.floor(Math.random() * activeList.length)];
    room.startingPlayerId = startingPlayer.id;

    room.status = 'reveal';
    room.currentPlayerIndex = 0;
    room.eliminationsCount = 0;
    room.drawings = [];

    // Emitir el estado genérico a la sala sin campos sensibles
    this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));

    // Enviar payloads individuales seguros a cada socket conectado
    room.players.forEach(p => {
      if (p.socketId) {
        const socketClient = this.server.sockets.sockets.get(p.socketId);
        if (socketClient) {
          this.sendIndividualRole(socketClient, p, room);
        }
      }
    });

    console.log(`Partida iniciada en la sala ${data.code}. Palabra: ${randomWordObj.word}`);
  }

  @SubscribeMessage('see-role')
  handleSeeRole(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    const player = room.players.find(p => p.socketId === client.id);
    if (!player) return;

    player.hasSeenRole = true;

    // Verificar si todos los jugadores activos han visto su rol
    const activePlayers = room.players.filter(p => p.status === 'active');
    const allSeen = activePlayers.every(p => p.hasSeenRole);

    if (allSeen) {
      room.status = 'play';
      console.log(`Fase de revelación finalizada en sala ${data.code}. Iniciando fase de juego.`);
    }

    this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));
  }

  @SubscribeMessage('eliminate-player')
  handleEliminatePlayer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; playerId: string },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    const player = room.players.find(p => p.id === data.playerId);
    if (player) {
      player.isEliminated = true;
      room.eliminationsCount++;
      
      // Comprobación de fin de juego (todas las muertes se notifican y el motor/host evalúa)
      this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));
      console.log(`Jugador ${player.name} eliminado en sala ${data.code}`);
    }
  }

  @SubscribeMessage('draw-stroke')
  handleDrawStroke(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; stroke: any },
  ) {
    // Retransmitir el trazo al resto de jugadores de la sala a alta frecuencia
    client.to(data.code).emit('stroke', data.stroke);
  }

  @SubscribeMessage('submit-drawing')
  handleSubmitDrawing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; drawing: string },
  ) {
    const room = this.rooms.get(data.code.toUpperCase());
    if (!room) return;
    room.drawings.push(data.drawing);
    this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));
    console.log(`Dibujo recibido en sala ${data.code}`);
  }

  @SubscribeMessage('submit-vote')
  handleSubmitVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; vote: { voterId: string; targetId: string } },
  ) {
    // Retransmitir votos en tiempo real a la sala
    this.server.to(data.code).emit('player-voted', data.vote);
  }

  @SubscribeMessage('submit-guess')
  handleSubmitGuess(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; guess: { detectiveId: string; word: string } },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    const isCorrect = room.secretWord?.word.toLowerCase().trim() === data.guess.word.toLowerCase().trim();
    this.server.to(data.code).emit('guess-result', {
      detectiveId: data.guess.detectiveId,
      word: data.guess.word,
      isCorrect,
    });
  }

  @SubscribeMessage('reset-game')
  handleResetGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string },
  ) {
    const room = this.rooms.get(data.code);
    if (!room) return;

    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    room.status = 'lobby';
    room.secretWord = null;
    room.startingPlayerId = null;
    room.currentPlayerIndex = 0;
    room.eliminationsCount = 0;
    room.drawings = [];
    room.players.forEach(p => {
      p.isImpostor = false;
      p.isDetective = false;
      p.hasSeenRole = false;
      p.isEliminated = false;
    });

    this.server.to(data.code).emit('room-state', this.sanitizeRoomState(room));
    console.log(`Sala resetada a Lobby: ${data.code}`);
  }

  // --- MÉTODOS DE AYUDA PRIVADOS ---

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  private sendIndividualRole(client: Socket, player: Player, room: RoomState) {
    const wordObj = room.secretWord;
    if (!wordObj) return;

    let roleWord = '';
    let roleHint = '';

    if (player.isImpostor) {
      roleWord = wordObj.fakeWord || '???';
      
      const hintSetting = room.settings.hints;
      if (hintSetting === 'all') {
        roleHint = wordObj.hint;
      } else if (hintSetting === 'first' && player.id === room.startingPlayerId) {
        roleHint = wordObj.hint;
      }
    } else {
      // Civil o Detective
      roleWord = wordObj.word;
      roleHint = wordObj.hint;
    }

    client.emit('role-payload', {
      isImpostor: player.isImpostor,
      isDetective: player.isDetective,
      word: roleWord,
      hint: roleHint,
      startingPlayerId: room.startingPlayerId,
    });
  }

  private removePlayerPermanently(code: string, playerId: string) {
    const room = this.rooms.get(code);
    if (!room) return;

    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== -1) {
      const removedPlayer = room.players[playerIndex];
      room.players.splice(playerIndex, 1);
      this.disconnectTimeouts.delete(`${code}:${playerId}`);

      console.log(`Jugador ${removedPlayer.name} eliminado definitivamente por desconexión en sala ${code}`);

      if (room.players.length === 0) {
        // Eliminar sala vacía
        this.rooms.delete(code);
        console.log(`Sala vacía eliminada: ${code}`);
      } else {
        // Si el Host se desconectó, realizar Host Migration
        if (removedPlayer.isHost) {
          const nextActiveHost = room.players.find(p => p.status === 'active');
          if (nextActiveHost) {
            nextActiveHost.isHost = true;
            console.log(`Host Migration en sala ${code}: nuevo anfitrión ${nextActiveHost.name}`);
          }
        }
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      }
    }
  }

  // Elimina datos confidenciales del estado global que se retransmite a la sala
  private sanitizeRoomState(room: RoomState): any {
    return {
      code: room.code,
      settings: room.settings,
      status: room.status,
      currentPlayerIndex: room.currentPlayerIndex,
      eliminationsCount: room.eliminationsCount,
      drawings: room.drawings,
      startingPlayerId: room.startingPlayerId,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        photoUrl: p.photoUrl,
        hasSeenRole: p.hasSeenRole,
        isEliminated: p.isEliminated,
        isHost: p.isHost,
        status: p.status,
        // Omitimos isImpostor e isDetective para que no se puedan hackear en el cliente
      })),
    };
  }
}
