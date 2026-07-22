import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const usepretty = process.env.NODE_ENV !== "production" && process.stdout.isTTY;

export const logger = pino(
  usepretty
    ? {
        level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level }
);

export type Logger = typeof logger;
