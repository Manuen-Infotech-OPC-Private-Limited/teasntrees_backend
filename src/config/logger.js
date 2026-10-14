import winston from 'winston';
import Transport from 'winston-transport';
import * as Sentry from '@sentry/node';
import path from 'path';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;

    // Add metadata if present
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }

    // Add stack trace for errors
    if (stack) {
        msg += `\n${stack}`;
    }

    return msg;
});

// Create logger instance
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        // Error logs
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // Combined logs
        new winston.transports.File({
            filename: 'logs/combined.log',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ]
});

// Every logger.error also goes to Sentry. Most failures in this codebase are
// caught in the controller, logged and answered with a 500, so they never
// reach Express's error handler; the log is where they surface.
// Routine noise is left out so it does not eat the free plan's quota.
const SENTRY_IGNORE = [/CORS blocked/i, /Rate Limit/i];

class SentryTransport extends Transport {
    log(info, callback) {
        setImmediate(() => this.emit('logged', info));
        if (Sentry.isEnabled()) {
            const message = String(info.message ?? '');
            if (!SENTRY_IGNORE.some((re) => re.test(message))) {
                const { level, message: _m, stack, timestamp: _t, ...extra } = info;
                if (stack) {
                    const err = new Error(message);
                    err.stack = stack;
                    Sentry.captureException(err, { extra });
                } else {
                    Sentry.captureMessage(message, { level: 'error', extra });
                }
            }
        }
        callback();
    }
}
logger.add(new SentryTransport({ level: 'error' }));

// Console logging in development
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: combine(
            colorize(),
            timestamp({ format: 'HH:mm:ss' }),
            logFormat
        )
    }));
}

// Create stream for Morgan
logger.stream = {
    write: (message) => logger.http(message.trim())
};

export default logger;
