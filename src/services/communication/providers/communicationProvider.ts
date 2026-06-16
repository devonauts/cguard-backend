/**
 * Stable import path for the CommunicationProvider interface (and the shapes
 * providers need). Provider modules should import from here so the canonical
 * type location (types.ts) can move without touching every provider.
 */
export type {
  CommunicationProvider,
  Channel,
  MessageType,
  DeliveryStatus,
  SendResult,
  OutboundMessage,
} from '../types';
