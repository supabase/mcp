const {
  createSupabaseMcpHandler,
  isToolCallerError,
  ToolCallerError,
} = require('@supabase/mcp-server-supabase');

if (typeof createSupabaseMcpHandler !== 'function') {
  throw new Error(
    `expected createSupabaseMcpHandler to be a function, got ${typeof createSupabaseMcpHandler}`
  );
}

// ToolCallerError is the only export matched across loaded copies, since a host may require() CJS while the server throws from ESM.
// This also guards the constructor-assigned brand, which a class field would miscompile in CJS.
async function checkToolCallerErrorAcrossBuilds() {
  const esm = await import('@supabase/mcp-server-supabase');
  if (esm.ToolCallerError === ToolCallerError) {
    throw new Error('expected separate ESM and CJS ToolCallerError classes');
  }
  const fromCjs = new ToolCallerError('bad input');
  const fromEsm = new esm.ToolCallerError('bad input');
  if (
    fromCjs.name !== 'ToolCallerError' ||
    !esm.isToolCallerError(fromCjs) ||
    !isToolCallerError(fromEsm) ||
    isToolCallerError(new Error('bad input'))
  ) {
    throw new Error(
      'ToolCallerError brand does not match across CJS and ESM builds'
    );
  }
}

// Exercise the require()-loaded implementation, not merely its export shape.
checkToolCallerErrorAcrossBuilds()
  .then(() => import('./modern-call.mjs'))
  .then(({ runConsumer }) => runConsumer(createSupabaseMcpHandler))
  .then(() => console.log('CJS_OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
