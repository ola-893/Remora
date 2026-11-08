import type { Tool } from 'ai';
import type { Gateway } from './index.mjs';
export function agentStreamsTools(client: Gateway): Record<'agentstreams_check' | 'agentstreams_open_stream' | 'agentstreams_close_stream' | 'agentstreams_fetch', Tool>;
