import { OfflineGateway, guardedFetch } from '@ola-893/agentstreams-core';
import { createNearGateway } from '@ola-893/agentstreams-core/near';
import { agentStreamsTools } from '@ola-893/agentstreams-core/vercel-ai';

const client = new OfflineGateway();
const request = guardedFetch(client.transport.bind(client), { client });
const response: Response = await request(`${client.serviceUrl}/research`);
console.log(response.status, Object.keys(agentStreamsTools(client)));
// Explicit live opt-in; native types remain available to SDK consumers.
const connect = () => createNearGateway({ configPath: '/private/profile/deployment.json', stateRoot: '/private/state', paymentsEnabled: false });
void connect;
