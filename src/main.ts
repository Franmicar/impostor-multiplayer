import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';

// Override console.log and console.error to log to a local file
const logFile = path.join(__dirname, '..', 'server_log.txt');
try {
  // Clear log file on startup
  fs.writeFileSync(logFile, `=== Server Start: ${new Date().toISOString()} ===\n`);
} catch (e) {}

const originalLog = console.log;
console.log = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  originalLog(...args);
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
};

const originalError = console.error;
console.error = (...args: any[]) => {
  const msg = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
  originalError(...args);
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [ERROR] ${msg}\n`);
  } catch (e) {}
};

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';


async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Habilitar CORS para permitir la conexión desde dispositivos nativos y web
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Deceptra V2 Multiplayer Server listening on port ${port}`);
}
bootstrap();
