import { Config } from './types';
import * as fs from 'fs';

function log(context: any): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    ...context
  }));
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue?: number): number {
  const value = process.env[name];
  if (value) {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      throw new Error(`Environment variable ${name} must be a valid number, got: ${value}`);
    }
    return parsed;
  }
  if (defaultValue !== undefined) {
    return defaultValue;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export function loadConfig(): Config {
  log({ event: 'config_loading' });

  const config: Config = {
    ETH_RPC_URL: getEnvVar('ETH_RPC_URL'),
    ETH_BRIDGE_ADDRESS: getEnvVar('ETH_BRIDGE_ADDRESS'),
    ETH_CONFIRMATIONS: getEnvNumber('ETH_CONFIRMATIONS', 3),
    ETH_START_BLOCK: getEnvNumber('ETH_START_BLOCK'),
    SOL_RPC_URL: getEnvVar('SOL_RPC_URL'),
    SOL_PROGRAM_ID: getEnvVar('SOL_PROGRAM_ID'),
    SOL_WRAPPED_MINT: getEnvVar('SOL_WRAPPED_MINT'),
    SOL_RELAYER_KEYPAIR: getEnvVar('SOL_RELAYER_KEYPAIR'),
    RETRY_INTERVAL_MS: getEnvNumber('RETRY_INTERVAL_MS', 30000),
    POLL_INTERVAL_MS: getEnvNumber('POLL_INTERVAL_MS', 10000),
    DB_PATH: getEnvVar('DB_PATH', './relayer.db')
  };

  // Validate Ethereum address format
  if (!config.ETH_BRIDGE_ADDRESS.startsWith('0x') || config.ETH_BRIDGE_ADDRESS.length !== 42) {
    throw new Error(`Invalid Ethereum bridge address: ${config.ETH_BRIDGE_ADDRESS}`);
  }

  // Validate RPC URLs
  if (!config.ETH_RPC_URL.startsWith('http')) {
    throw new Error(`Invalid Ethereum RPC URL: ${config.ETH_RPC_URL}`);
  }

  if (!config.SOL_RPC_URL.startsWith('http')) {
    throw new Error(`Invalid Solana RPC URL: ${config.SOL_RPC_URL}`);
  }

  // Validate keypair file exists
  if (!fs.existsSync(config.SOL_RELAYER_KEYPAIR)) {
    throw new Error(`Relayer keypair file not found: ${config.SOL_RELAYER_KEYPAIR}`);
  }

  // Validate intervals
  if (config.RETRY_INTERVAL_MS < 1000) {
    throw new Error('RETRY_INTERVAL_MS must be at least 1000ms');
  }

  if (config.POLL_INTERVAL_MS < 1000) {
    throw new Error('POLL_INTERVAL_MS must be at least 1000ms');
  }

  if (config.ETH_CONFIRMATIONS < 1) {
    throw new Error('ETH_CONFIRMATIONS must be at least 1');
  }

  log({
    event: 'config_loaded',
    eth_rpc: config.ETH_RPC_URL.split('/').slice(0, 3).join('/') + '/***',
    eth_bridge: config.ETH_BRIDGE_ADDRESS,
    eth_confirmations: config.ETH_CONFIRMATIONS,
    eth_start_block: config.ETH_START_BLOCK,
    sol_rpc: config.SOL_RPC_URL.split('/').slice(0, 3).join('/') + '/***',
    sol_program: config.SOL_PROGRAM_ID,
    sol_mint: config.SOL_WRAPPED_MINT,
    keypair_path: '[REDACTED]',
    retry_interval: config.RETRY_INTERVAL_MS,
    poll_interval: config.POLL_INTERVAL_MS,
    db_path: config.DB_PATH
  });

  return config;
}