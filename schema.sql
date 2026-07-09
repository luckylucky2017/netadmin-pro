-- NetAdmin Pro — cấu trúc cơ sở dữ liệu (chỉ DDL, không có dữ liệu).
--
-- Dump bằng: mysqldump --no-data --routines --triggers --set-gtid-purged=OFF <database>
-- Không bắt buộc phải chạy file này — ứng dụng tự tạo schema + seed vai trò/tài khoản admin đầu
-- tiên khi chạy `npm start` lần đầu (xem database.js). File này chỉ để tham khảo cấu trúc bảng,
-- hoặc để khởi tạo DB thủ công trước khi khởi động ứng dụng lần đầu (vd qua công cụ DBA/CI).
--
-- Không chứa bất kỳ dữ liệu thật nào (mật khẩu, private key, thông tin hạ tầng...) — toàn bộ cấu
-- hình nhạy cảm (vCenter, tài khoản SSH, AI key, SSO) được nhập qua giao diện sau khi đăng nhập,
-- lưu trong các bảng vcenter_clusters/ssh_credentials/app_settings, không nằm trong file này.


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
DROP TABLE IF EXISTS `activity_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `activity_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `action` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `entity_type` text COLLATE utf8mb4_unicode_ci,
  `entity_id` int DEFAULT NULL,
  `entity_name` text COLLATE utf8mb4_unicode_ci,
  `details` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `user_id` int DEFAULT NULL,
  `user_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_email` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `alert_rules`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `alert_rules` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `scope_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'all',
  `scope_id` int DEFAULT NULL,
  `metric` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `operator` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '>',
  `threshold` double NOT NULL,
  `duration_sec` int NOT NULL DEFAULT '60',
  `severity` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'medium',
  `category` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'resource',
  `enabled` int NOT NULL DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `alerts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `alerts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `category` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `severity` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `title` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text COLLATE utf8mb4_unicode_ci,
  `source_type` text COLLATE utf8mb4_unicode_ci,
  `source_id` int DEFAULT NULL,
  `source_name` text COLLATE utf8mb4_unicode_ci,
  `metric` text COLLATE utf8mb4_unicode_ci,
  `metric_value` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'open',
  `acked_by` text COLLATE utf8mb4_unicode_ci,
  `rule_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `acked_at` datetime DEFAULT NULL,
  `resolved_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `app_settings`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_settings` (
  `id` int NOT NULL DEFAULT '1',
  `anthropic_api_key` text COLLATE utf8mb4_unicode_ci,
  `saml_idp_entry_point` text COLLATE utf8mb4_unicode_ci,
  `saml_idp_cert` text COLLATE utf8mb4_unicode_ci,
  `saml_sp_entity_id` text COLLATE utf8mb4_unicode_ci,
  `saml_sp_callback_url` text COLLATE utf8mb4_unicode_ci,
  `ldap_url` text COLLATE utf8mb4_unicode_ci,
  `ldap_bind_dn` text COLLATE utf8mb4_unicode_ci,
  `ldap_bind_password` text COLLATE utf8mb4_unicode_ci,
  `ldap_base_dn` text COLLATE utf8mb4_unicode_ci,
  `ldap_user_filter` text COLLATE utf8mb4_unicode_ci,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `import_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `import_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `filename` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `total_rows` int DEFAULT '0',
  `imported` int DEFAULT '0',
  `skipped` int DEFAULT '0',
  `errors` text COLLATE utf8mb4_unicode_ci,
  `imported_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `metrics_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `metrics_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `server_id` int NOT NULL,
  `cpu_pct` double DEFAULT NULL,
  `ram_pct` double DEFAULT NULL,
  `disk_pct` double DEFAULT NULL,
  `recorded_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_metrics_server_time` (`server_id`,`recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `monitor_checks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `monitor_checks` (
  `id` int NOT NULL AUTO_INCREMENT,
  `monitor_id` int NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status_code` int DEFAULT NULL,
  `response_ms` int DEFAULT NULL,
  `error` text COLLATE utf8mb4_unicode_ci,
  `checked_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_monitor_checks_time` (`monitor_id`,`checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `monitors`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `monitors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `url` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `keyword` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `keyword_type` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'contains',
  `check_interval_sec` int NOT NULL DEFAULT '300',
  `timeout_sec` int NOT NULL DEFAULT '10',
  `ignore_tls_errors` int NOT NULL DEFAULT '0',
  `enabled` int NOT NULL DEFAULT '1',
  `current_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `last_checked_at` datetime DEFAULT NULL,
  `last_response_ms` int DEFAULT NULL,
  `last_status_code` int DEFAULT NULL,
  `last_error` text COLLATE utf8mb4_unicode_ci,
  `cert_expires_at` datetime DEFAULT NULL,
  `cert_issuer` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `network_devices`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `network_devices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `hostname` text COLLATE utf8mb4_unicode_ci,
  `ip_address` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `mac_address` text COLLATE utf8mb4_unicode_ci,
  `type` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `brand` text COLLATE utf8mb4_unicode_ci,
  `model` text COLLATE utf8mb4_unicode_ci,
  `firmware` text COLLATE utf8mb4_unicode_ci,
  `location` text COLLATE utf8mb4_unicode_ci,
  `vlan` text COLLATE utf8mb4_unicode_ci,
  `ports` int DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `last_ping` datetime DEFAULT NULL,
  `ping_ms` int DEFAULT NULL,
  `snmp_community` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT 'public',
  `tags` text COLLATE utf8mb4_unicode_ci,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `snmp_port` int DEFAULT '161',
  `snmp_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `snmp_uptime_sec` bigint DEFAULT NULL,
  `snmp_cpu_pct` double DEFAULT NULL,
  `snmp_mem_used_pct` double DEFAULT NULL,
  `snmp_interfaces` text COLLATE utf8mb4_unicode_ci,
  `snmp_if_prev_snapshot` text COLLATE utf8mb4_unicode_ci,
  `snmp_checked_at` datetime DEFAULT NULL,
  `snmp_error` text COLLATE utf8mb4_unicode_ci,
  `snmp_enabled` int DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `outbound_connections`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `outbound_connections` (
  `id` int NOT NULL AUTO_INCREMENT,
  `vm_id` int NOT NULL,
  `vm_name` text COLLATE utf8mb4_unicode_ci,
  `remote_ip` varchar(45) COLLATE utf8mb4_unicode_ci NOT NULL,
  `remote_port` int DEFAULT NULL,
  `country` text COLLATE utf8mb4_unicode_ci,
  `is_foreign` int NOT NULL DEFAULT '0',
  `process_name` text COLLATE utf8mb4_unicode_ci,
  `pid` int DEFAULT NULL,
  `first_seen` datetime DEFAULT CURRENT_TIMESTAMP,
  `last_seen` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_outbound` (`vm_id`,`remote_ip`,`remote_port`),
  KEY `idx_outbound_vm` (`vm_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ping_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ping_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `device_id` int NOT NULL,
  `device_type` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `ping_ms` int DEFAULT NULL,
  `checked_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `role_permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `role_permissions` (
  `role_id` int NOT NULL,
  `permission` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`role_id`,`permission`),
  CONSTRAINT `role_permissions_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `roles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `roles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_system` int NOT NULL DEFAULT '0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `servers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `servers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `hostname` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `ip_address` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT 'server',
  `os` text COLLATE utf8mb4_unicode_ci,
  `cpu` text COLLATE utf8mb4_unicode_ci,
  `ram` text COLLATE utf8mb4_unicode_ci,
  `storage` text COLLATE utf8mb4_unicode_ci,
  `location` text COLLATE utf8mb4_unicode_ci,
  `rack` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `last_ping` datetime DEFAULT NULL,
  `ping_ms` int DEFAULT NULL,
  `ssh_port` int DEFAULT '22',
  `ssh_user` text COLLATE utf8mb4_unicode_ci,
  `tags` text COLLATE utf8mb4_unicode_ci,
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `ipmi_host` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ipmi_username` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `ipmi_password` text COLLATE utf8mb4_unicode_ci,
  `ipmi_power_state` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `ipmi_health` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `ipmi_checked_at` datetime DEFAULT NULL,
  `ipmi_error` text COLLATE utf8mb4_unicode_ci,
  `snmp_port` int DEFAULT '161',
  `snmp_status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `snmp_uptime_sec` bigint DEFAULT NULL,
  `snmp_cpu_pct` double DEFAULT NULL,
  `snmp_mem_used_pct` double DEFAULT NULL,
  `snmp_interfaces` text COLLATE utf8mb4_unicode_ci,
  `snmp_if_prev_snapshot` text COLLATE utf8mb4_unicode_ci,
  `snmp_checked_at` datetime DEFAULT NULL,
  `snmp_error` text COLLATE utf8mb4_unicode_ci,
  `snmp_community` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `snmp_enabled` int DEFAULT '0',
  `ipmi_sensors` text COLLATE utf8mb4_unicode_ci,
  `ipmi_sel_log` text COLLATE utf8mb4_unicode_ci,
  `ssh_credential_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sessions` (
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expires` int unsigned NOT NULL,
  `data` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ssh_credentials`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ssh_credentials` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `auth_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'private_key',
  `username` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `private_key` text COLLATE utf8mb4_unicode_ci,
  `passphrase` text COLLATE utf8mb4_unicode_ci,
  `password` text COLLATE utf8mb4_unicode_ci,
  `is_default` int NOT NULL DEFAULT '0',
  `notes` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ssh_log_cursor`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ssh_log_cursor` (
  `source_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_id` int NOT NULL,
  `last_line_count` int NOT NULL DEFAULT '0',
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`source_type`,`source_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ssh_login_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ssh_login_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `source_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_id` int NOT NULL,
  `source_name` text COLLATE utf8mb4_unicode_ci,
  `event_type` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `username` text COLLATE utf8mb4_unicode_ci,
  `src_ip` text COLLATE utf8mb4_unicode_ci,
  `country` text COLLATE utf8mb4_unicode_ci,
  `is_foreign` int NOT NULL DEFAULT '0',
  `occurred_at` datetime NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ssh_events_source_time` (`source_type`,`source_id`,`occurred_at`),
  KEY `idx_ssh_events_time` (`occurred_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` text COLLATE utf8mb4_unicode_ci,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `auth_provider` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'local',
  `external_id` text COLLATE utf8mb4_unicode_ci,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `last_login_at` datetime DEFAULT NULL,
  `role_id` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `fk_users_role_id` (`role_id`),
  CONSTRAINT `fk_users_role_id` FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `vcenter_clusters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `vcenter_clusters` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `host` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `username` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `password` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `insecure` int NOT NULL DEFAULT '1',
  `enabled` int NOT NULL DEFAULT '1',
  `status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `last_synced_at` datetime DEFAULT NULL,
  `last_error` text COLLATE utf8mb4_unicode_ci,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `vcenter_vms`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `vcenter_vms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `moref` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `power_state` text COLLATE utf8mb4_unicode_ci,
  `cpu_count` int DEFAULT NULL,
  `memory_mib` int DEFAULT NULL,
  `cpu_pct` double DEFAULT NULL,
  `mem_pct` double DEFAULT NULL,
  `disk_pct` double DEFAULT NULL,
  `stats_updated_at` datetime DEFAULT NULL,
  `last_synced_at` datetime DEFAULT NULL,
  `ip_address` text COLLATE utf8mb4_unicode_ci,
  `guest_family` text COLLATE utf8mb4_unicode_ci,
  `ssh_user` text COLLATE utf8mb4_unicode_ci,
  `ssh_port` int DEFAULT NULL,
  `fail2ban_status` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT 'unknown',
  `fail2ban_checked_at` datetime DEFAULT NULL,
  `fail2ban_error` text COLLATE utf8mb4_unicode_ci,
  `vcenter_cluster_id` int DEFAULT NULL,
  `ssh_credential_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_vcenter_vm` (`vcenter_cluster_id`,`moref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `vm_metrics_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `vm_metrics_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `vm_id` int NOT NULL,
  `cpu_pct` double DEFAULT NULL,
  `mem_pct` double DEFAULT NULL,
  `disk_pct` double DEFAULT NULL,
  `recorded_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_vmmetrics_vm_time` (`vm_id`,`recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

