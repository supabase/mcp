const { createSupabaseMcpHandler } = require('@supabase/mcp-server-supabase');

if (typeof createSupabaseMcpHandler !== 'function') {
  throw new Error(
    `expected createSupabaseMcpHandler to be a function, got ${typeof createSupabaseMcpHandler}`
  );
}

// Exercise the require()-loaded implementation, not merely its export shape.
import('./modern-call.mjs')
  .then(({ runConsumer }) => runConsumer(createSupabaseMcpHandler))
  .then(() => console.log('CJS_OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
