const config={
  poweredByHeader:false,
  allowedDevOrigins:['127.0.0.1','localhost'],
  // Root npm run typecheck is the strict check; Next's worker cannot parse this TS CLI output.
  typescript:{ignoreBuildErrors:true},
  experimental:{useTypeScriptCli:false},
};
export default config;
