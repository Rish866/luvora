import { JobRegistry } from "./jobRegistry";
import { NotificationPushDeliveryHandler } from "./handlers/notificationPushDeliveryHandler";
import { NotificationCleanupHandler } from "./handlers/notificationCleanupHandler";
import { PresenceReconciliationHandler } from "./handlers/presenceReconciliationHandler";
import { BackgroundJobCleanupHandler } from "./handlers/backgroundJobCleanupHandler";

/** Build a registry wired with every production job handler. */
export function buildDefaultRegistry(): JobRegistry {
  const registry = new JobRegistry();
  registry.register(new NotificationPushDeliveryHandler());
  registry.register(new NotificationCleanupHandler());
  registry.register(new PresenceReconciliationHandler());
  registry.register(new BackgroundJobCleanupHandler());
  return registry;
}
