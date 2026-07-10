/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Notification module. Imports AuthModule (JwtAuthGuard for the recipient-scoped read
 * endpoints) and RealtimeModule (RealtimeService for the recipient-scoped `notification.created` SSE).
 * Exports NotificationService so domain modules (customers, auth/mfa, password-reset) can `emit()` from
 * their use-cases without duplicating the audit trail.
 *
 * NOTE: NotificationModule deliberately does NOT depend back on the security-event producers that emit to
 * it (auth/mfa). MfaManagementService (in AuthModule, which RealtimeModule already imports) resolves
 * NotificationService lazily via ModuleRef instead of a module import, so no AuthModule<->NotificationModule
 * import cycle is created (that would also drag RealtimeModule into the cycle). Password-reset, which is
 * NOT in the Notification import graph, imports NotificationModule directly.
 */
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RealtimeModule } from "../realtime/realtime.module";
import { NotificationController } from "./notification.controller";
import { NotificationPruneScheduler } from "./notification-prune.scheduler";
import { NotificationService } from "./notification.service";

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationPruneScheduler],
  exports: [NotificationService],
})
export class NotificationModule {}
