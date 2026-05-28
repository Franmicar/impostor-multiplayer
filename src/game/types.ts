export interface Player {
  id: string; // Stable UUID or Auth ID from client
  name: string;
  photoUrl?: string;
  isImpostor: boolean;
  isDetective?: boolean;
  hasSeenRole: boolean;
  isEliminated?: boolean;
  socketId?: string; // Current connected Socket.io ID
  isHost?: boolean;
  status?: 'active' | 'away';
}

export interface GameSettings {
  playerData: { id: string; name: string; photoUrl?: string }[];
  words: { word: string; hint: string; fakeWord?: string }[];
  numImpostors: number;
  numDetectives: number;
  modeId: string;
  gameTypeId: 'word' | 'question' | 'draw';
  duration?: string;
  hints?: string;
  drawTurnTime?: number;
}

export interface RematchState {
  status: 'idle' | 'rematch-check';
  readyPlayers: string[]; // IDs de jugadores que aceptaron revancha
  lastActivePlayers: { id: string; name: string; photoUrl?: string }[]; // Jugadores al terminar la última partida
}

export interface RoomState {
  code: string;
  settings: GameSettings;
  players: Player[];
  status: 'lobby' | 'reveal' | 'play' | 'vote' | 'vote-resolved' | 'results';
  secretWord: { word: string; hint: string; fakeWord?: string } | null;
  startingPlayerId: string | null;
  currentPlayerIndex: number;
  eliminationsCount: number;
  drawings: string[];
  votingState?: {
    votes: { [voterId: string]: string }; // voterId -> targetId
    timeLeft: number;
    totalTime: number;
    resolution?: {
      eliminatedPlayerId: string | null;
      eliminatedPlayerName: string;
      isImpostor: boolean;
      isTie: boolean;
      voteCounts: { [targetId: string]: number };
      timeLeft: number;
      isGuessFail?: boolean;
      guessWord?: string;
    };
  };
  winnerTeam?: 'town' | 'impostors' | null;
  resultsData?: any;
  rematchState?: RematchState;
}
