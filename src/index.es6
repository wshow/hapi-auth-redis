// Validation Plugin
import joi from 'joi';
// Assert Errors
import hoek from 'hoek';
// Http Error
import boom from 'boom';
// Redis Client
import redis from 'promise-redis';

const internals = {};

internals.schema = joi.object({
  param: joi.string().default('auth'),
  host: joi.string().default('127.0.0.1'),
  port: joi.number().integer().min(1).max(65535).default(6379),
  db: joi.number().integer().min(0).max(255).default(0),
  password: joi.string().default(''),
  ttl: joi.number().integer().min(0).default(3600),
  validateFunc: joi.func()
}).required();

internals.implementation = (server, options) => {
  const results = joi.validate(options, internals.schema);
  hoek.assert(!results.error, results.error);

  const settings = results.value;

  const redisOptions = {
    port: settings.port,
    host: settings.host,
    auth_pass: settings.password,
    ttl: settings.ttl,
    db: settings.db
  };
  const client = redis().createClient(redisOptions);
  client.on('error', (err) => {
    hoek.assert(!err, err);
  });

  server.ext('onPreAuth', (request, reply) => {
    request.auth.redis = {
      set: async(key, session) => {
        hoek.assert(session && typeof session === 'object', 'Invalid session');
        await client.select(redisOptions.db);
        await client.set(`${settings.param}:${key}`, JSON.stringify(session));
        await client.expire(`${settings.param}:${key}`, redisOptions.ttl);
        request.auth.artifacts = session;
      },
      expire: async(key) => {
        if (key) {
          const session = request.auth.artifacts;
          hoek.assert(session, 'No active session to expire key from');
          await client.select(redisOptions.db);
          await client.expire(`${settings.param}:${key}`, 0);
        }
        request.auth.artifacts = null;
      }
    };
    return reply.continue();
  });
  const scheme = {
    authenticate: async(request, reply) => {
      const key = settings.param;
      let token = '';
      if (request.payload && request.payload[key]) {
        token = request.payload[key];
      } else if (request.query && request.query[key]) {
        token = request.query[key];
      }
      await client.select(redisOptions.db);
      let session = await client.get(`${key}:${token}`);
      session = JSON.parse(session || '{}');
      if (!settings.validateFunc) {
        return reply.continue({credentials: session, artifacts: session});
      }
      settings.validateFunc(request, session, (err, isValid, credentials) => {
        if (err || !isValid) {
          return reply(boom.unauthorized(`Invalid ${key}`), null, {
            credentials: credentials || session,
            artifacts: session
          });
        }
        return reply.continue({credentials: credentials || session, artifacts: session});
      });
    }
  };
  return scheme;
};

exports.register = (server, options, next) => {
  server.auth.scheme('redis', internals.implementation);
  next();
};

exports.register.attributes = {
  pkg: require('../package.json')
};
