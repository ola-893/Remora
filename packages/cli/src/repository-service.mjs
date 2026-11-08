import { startProvider } from '@ola-893/agentstreams-core/internal-provider';
import { analyzeRepository, repositoryResponse } from './repository-analysis.mjs';

export async function startRepositoryService(config, { repository, port = 5380, rates, durationSeconds } = {}) {
  if (!repository) throw new Error('Specify --repository with the operator-selected repository directory.');
  let cached = await analyzeRepository(repository), refresh;
  const providerConfig = { ...config };
  const service = await startProvider(providerConfig, { port, rates, durationSeconds, handleRequest: async params => {
    if (Date.now() - new Date(cached.generatedAt).getTime() > 5000) {
      refresh ??= analyzeRepository(repository).then(next => { cached = next; }).finally(() => { refresh = undefined; });
      await refresh;
    }
    return repositoryResponse(cached, params);
  } });
  providerConfig.serviceUrl = service.origin;
  return { ...service, summary: { source: cached.source, fingerprint: cached.fingerprint, coverage: cached.coverage, pricing: { rates: rates || { basic: '10', premium: '200' }, durationSeconds: durationSeconds || 1000, units: 'raw USDC per second; 1000000 raw = 1 USDC', settlement: 'Time-based access, not per-request billing. Accrual continues until closure or lease expiry, including idle time and time before a failure threshold closes the stream.' }, protocol: 'agentpay-near-v1', path: config.service?.requestPath || '/research', views: ['overview', 'findings', 'dependencies'], privateKeysRequired: false } };
}
