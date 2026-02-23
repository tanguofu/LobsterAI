import * as fs from 'fs';
import * as path from 'path';

export interface GatewayConfig {
  port: number;
  host: string;
}

const defaultConfig: GatewayConfig = {
  port: 3000,
  host: '0.0.0.0',
};

export function loadConfig(): GatewayConfig {
  const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const loaded = JSON.parse(raw) as Partial<GatewayConfig>;
    return {
      port: loaded.port ?? defaultConfig.port,
      host: loaded.host ?? defaultConfig.host,
    };
  } catch {
    return {
      port: process.env.PORT ? parseInt(process.env.PORT, 10) : defaultConfig.port,
      host: process.env.HOST || defaultConfig.host,
    };
  }
}
