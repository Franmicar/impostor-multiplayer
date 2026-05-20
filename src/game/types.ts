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

export interface RoomState {
  code: string;
  settings: GameSettings;
  players: Player[];
  status: 'lobby' | 'reveal' | 'play' | 'vote' | 'results';
  secretWord: { word: string; hint: string; fakeWord?: string } | null;
  startingPlayerId: string | null;
  currentPlayerIndex: number;
  eliminationsCount: number;
  drawings: string[];
}
