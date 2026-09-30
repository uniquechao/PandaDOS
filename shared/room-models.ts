import type { RoomMemberModel, RoomModelProvider, RoomReasoningEffort } from './rooms';

/** Public capability hints; never include executable paths or authentication data. */
export interface RoomModelCatalog {
  defaultModel?: RoomMemberModel;
  providers: Array<{
    provider: RoomModelProvider;
    available: boolean;
    models: Array<{ id: string; efforts: RoomReasoningEffort[] }>;
    defaultModel?: string;
    reason?: string;
    metering?: 'model_requests' | 'cli_invocations';
  }>;
}
