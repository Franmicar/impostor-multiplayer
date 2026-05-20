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
  // Control de temporizadores de votación online
  private votingIntervals = new Map<string, NodeJS.Timeout>();

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

  @SubscribeMessage('start-voting')
  handleStartVoting(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string },
  ) {
    const room = this.rooms.get(data.code.toUpperCase());
    if (!room) return;

    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    const durationMinutes = parseInt(room.settings.duration || '0', 10);
    const timeLeft = durationMinutes > 0 ? durationMinutes * 60 : 0;

    room.status = 'vote';
    room.votingState = {
      votes: {},
      timeLeft,
      totalTime: timeLeft,
    };
    
    room.winnerTeam = undefined;
    room.resultsData = undefined;

    this.server.to(data.code.toUpperCase()).emit('room-state', this.sanitizeRoomState(room));
    console.log(`Iniciando votación en sala ${data.code}. Tiempo: ${timeLeft}s`);

    if (timeLeft > 0) {
      this.startVotingTimer(data.code.toUpperCase());
    }
  }

  @SubscribeMessage('cast-vote')
  handleCastVote(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; targetId: string },
  ) {
    const code = data.code.toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.status !== 'vote' || !room.votingState) return;

    const player = room.players.find(p => p.socketId === client.id);
    if (!player || player.isEliminated || player.status !== 'active') return;

    // A player can only vote once
    if (room.votingState.votes[player.id]) return;

    room.votingState.votes[player.id] = data.targetId;
    console.log(`Voto registrado en sala ${code}: ${player.name} -> ${data.targetId}`);

    // Check if all active alive players have voted
    const activeAlivePlayers = room.players.filter(p => p.status === 'active' && !p.isEliminated);
    const totalVotesCast = Object.keys(room.votingState.votes).length;

    if (totalVotesCast >= activeAlivePlayers.length) {
      this.clearVotingTimer(code);
      this.resolveVoting(code);
    } else {
      this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
    }
  }

  @SubscribeMessage('submit-guess')
  handleSubmitGuess(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string; guess: { detectiveId: string; word: string } },
  ) {
    const code = data.code.toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return;

    const detectivePlayer = room.players.find(p => p.id === data.guess.detectiveId);
    if (!detectivePlayer || detectivePlayer.isEliminated || !detectivePlayer.isDetective) return;

    const isCorrect = room.secretWord?.word.toLowerCase().trim() === data.guess.word.toLowerCase().trim();
    
    // Broadcast the guess results event so clients can play sounds/animations
    this.server.to(code).emit('guess-result', {
      detectiveId: data.guess.detectiveId,
      word: data.guess.word,
      isCorrect,
    });

    if (isCorrect) {
      // Detective wins the game for the town!
      this.clearVotingTimer(code);
      room.status = 'results';
      room.winnerTeam = 'town';
      room.resultsData = {
        reason: 'guess',
        guess: data.guess.word,
        detectiveId: data.guess.detectiveId,
      };
      this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      console.log(`Partida terminada en sala ${code}: Detective adivinó correctamente la palabra.`);
    } else {
      // Detective guess failed: eliminate detective
      detectivePlayer.isEliminated = true;
      room.eliminationsCount++;
      console.log(`Detective ${detectivePlayer.name} falló adivinación y es eliminado en sala ${code}`);

      // Check win conditions
      const winResult = this.checkWinConditionsOnServer(room);
      if (winResult) {
        this.clearVotingTimer(code);
        room.status = 'results';
        room.winnerTeam = winResult.winner;
        room.resultsData = {
          reason: 'guess', // will display guess fail message because winner is impostors
          guess: data.guess.word,
          detectiveId: data.guess.detectiveId,
        };
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      } else {
        // Game continues: enter vote-resolved phase for 6 seconds
        this.clearVotingTimer(code);
        room.status = 'vote-resolved';
        room.votingState = {
          votes: room.votingState?.votes || {},
          timeLeft: 6,
          totalTime: 6,
          resolution: {
            eliminatedPlayerId: detectivePlayer.id,
            eliminatedPlayerName: detectivePlayer.name,
            isImpostor: false,
            isTie: false,
            voteCounts: {},
            timeLeft: 6,
            isGuessFail: true,
            guessWord: data.guess.word,
          }
        };
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
        this.startResolutionTimer(code);
      }
    }
  }

  @SubscribeMessage('reset-game')
  handleResetGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { code: string },
  ) {
    const code = data.code.toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return;

    const host = room.players.find(p => p.socketId === client.id);
    if (!host || !host.isHost) return;

    this.clearVotingTimer(code);

    room.status = 'lobby';
    room.secretWord = null;
    room.startingPlayerId = null;
    room.currentPlayerIndex = 0;
    room.eliminationsCount = 0;
    room.drawings = [];
    room.votingState = undefined;
    room.winnerTeam = undefined;
    room.resultsData = undefined;
    
    room.players.forEach(p => {
      p.isImpostor = false;
      p.isDetective = false;
      p.hasSeenRole = false;
      p.isEliminated = false;
    });

    this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
    console.log(`Sala resetada a Lobby: ${code}`);
  }

  // --- MÉTODOS DE VOTO Y TEMPORIZADOR AUTORITATIVOS ---

  private startVotingTimer(code: string) {
    this.clearVotingTimer(code);

    const interval = setInterval(() => {
      const room = this.rooms.get(code);
      if (!room || room.status !== 'vote' || !room.votingState) {
        this.clearVotingTimer(code);
        return;
      }

      if (room.votingState.timeLeft > 0) {
        room.votingState.timeLeft--;
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      } else {
        this.clearVotingTimer(code);
        this.resolveVoting(code);
      }
    }, 1000);

    this.votingIntervals.set(code, interval);
  }

  private startResolutionTimer(code: string) {
    this.clearVotingTimer(code); // Safe clear

    const interval = setInterval(() => {
      const room = this.rooms.get(code);
      if (!room || room.status !== 'vote-resolved' || !room.votingState || !room.votingState.resolution) {
        this.clearVotingTimer(code);
        return;
      }

      if (room.votingState.resolution.timeLeft > 0) {
        room.votingState.resolution.timeLeft--;
        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      } else {
        this.clearVotingTimer(code);
        
        // Transition back to 'play' status automatically
        room.status = 'play';
        room.votingState = undefined;

        // Choose a new random starting player from alive ones
        const activeList = room.players.filter(p => p.status === 'active' && !p.isEliminated);
        if (activeList.length > 0) {
          const startingPlayer = activeList[Math.floor(Math.random() * activeList.length)];
          room.startingPlayerId = startingPlayer.id;
        }

        // Send role updates to any reconnecting / existing players to refresh their views
        room.players.forEach(p => {
          if (p.socketId) {
            const socketClient = this.server.sockets.sockets.get(p.socketId);
            if (socketClient) {
              this.sendIndividualRole(socketClient, p, room);
            }
          }
        });

        this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
        console.log(`Transición automática de resolución a nueva ronda de discusión en sala ${code}`);
      }
    }, 1000);

    this.votingIntervals.set(code, interval);
  }

  private clearVotingTimer(code: string) {
    const interval = this.votingIntervals.get(code);
    if (interval) {
      clearInterval(interval);
      this.votingIntervals.delete(code);
    }
  }

  private resolveVoting(code: string) {
    const room = this.rooms.get(code);
    if (!room || !room.votingState) return;

    const votes = room.votingState.votes;
    const voteCounts: { [targetId: string]: number } = {};

    Object.values(votes).forEach(targetId => {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let candidatesWithMaxVotes: string[] = [];

    Object.entries(voteCounts).forEach(([targetId, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        candidatesWithMaxVotes = [targetId];
      } else if (count === maxVotes) {
        candidatesWithMaxVotes.push(targetId);
      }
    });

    let eliminatedPlayerId: string | null = null;
    let isTie = false;

    if (candidatesWithMaxVotes.length === 0) {
      isTie = true;
    } else if (candidatesWithMaxVotes.length > 1) {
      isTie = true;
    } else {
      eliminatedPlayerId = candidatesWithMaxVotes[0];
    }

    let eliminatedPlayerName = '';
    let isImpostor = false;

    if (eliminatedPlayerId && !isTie) {
      const player = room.players.find(p => p.id === eliminatedPlayerId);
      if (player) {
        player.isEliminated = true;
        room.eliminationsCount++;
        eliminatedPlayerName = player.name;
        isImpostor = player.isImpostor;
        console.log(`Votación en sala ${code}: Jugador ${player.name} fue eliminado.`);
      }
    } else {
      console.log(`Votación en sala ${code}: Empate, nadie es eliminado.`);
    }

    // Check win conditions after elimination
    const winResult = this.checkWinConditionsOnServer(room);

    if (winResult) {
      // Set to results screen immediately
      room.status = 'results';
      room.winnerTeam = winResult.winner;
      room.resultsData = {
        reason: 'vote',
        eliminatedPlayerId,
        eliminatedPlayerName,
        isImpostor,
        isTie,
        voteCounts,
      };
      this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      console.log(`Partida terminada en sala ${code}: Ganó el equipo ${winResult.winner}`);
    } else {
      // Game continues: enter vote-resolved phase for 6 seconds
      room.status = 'vote-resolved';
      room.votingState = {
        votes,
        timeLeft: 6,
        totalTime: 6,
        resolution: {
          eliminatedPlayerId,
          eliminatedPlayerName,
          isImpostor,
          isTie,
          voteCounts,
          timeLeft: 6,
        }
      };
      this.server.to(code).emit('room-state', this.sanitizeRoomState(room));
      this.startResolutionTimer(code);
    }
  }

  private checkWinConditionsOnServer(room: RoomState): { winner: 'town' | 'impostors'; reason?: string } | null {
    const alivePlayers = room.players.filter(p => p.status === 'active' && !p.isEliminated);
    const aliveImpostors = alivePlayers.filter(p => p.isImpostor).length;
    const aliveTownies = alivePlayers.length - aliveImpostors;
    const originalImpostors = room.players.filter(p => p.isImpostor).length;
    const aliveDetectives = alivePlayers.filter(p => p.isDetective).length;
    const totalOriginalPlayers = room.players.length;
    const eliminations = room.eliminationsCount;
    const modeId = room.settings.modeId;

    if (modeId === 'chaos') {
      if (originalImpostors === 0) {
        if (eliminations >= 1) {
          return { winner: 'town' };
        }
        return null;
      }

      if (originalImpostors === totalOriginalPlayers) {
        if (eliminations >= 2) {
          return { winner: 'impostors' };
        }
        return null;
      }

      if (aliveImpostors === 0) {
        return { winner: 'town' };
      }
      if (aliveTownies === 0) {
        return { winner: 'impostors' };
      }
      return null;
    }

    if (originalImpostors === 0) {
      if (aliveDetectives === 0) {
        return { winner: 'town' };
      }
      return null;
    }

    if (aliveImpostors === 0) {
      return { winner: 'town' };
    } else if (aliveImpostors >= aliveTownies) {
      return { winner: 'impostors' };
    }

    return null;
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
        this.clearVotingTimer(code);
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
      votingState: room.votingState,
      winnerTeam: room.winnerTeam,
      resultsData: room.resultsData,
    };
  }
}
