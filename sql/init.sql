-- ============================================================================
-- CCAPI 服务端数据库初始化脚本
-- 用法（手动执行）:
--   mysql -uroot -proot < sql/init.sql
-- 或在 CCAPI 服务端 UI 中点击「初始化数据库」按钮，由 Tauri 自动执行。
--
-- 默认账号:  admin / 123456   (首次登录强制修改密码)
-- 默认数据库连接: root / root  (服务端 UI 可改)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `ccapi`
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `ccapi`;

-- ----------------------------------------------------------------------------
-- 角色：每个角色携带一组权限（合并设计，无需单独 permissions 表）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `roles` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name`        VARCHAR(64)     UNIQUE NOT NULL,
  `description` VARCHAR(255)    DEFAULT NULL,
  `is_system`   TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '内建角色不可删',
  `permissions` JSON            NOT NULL COMMENT '["user.read","code.create",...] or ["*"]',
  `created_at`  DATETIME        DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 用户
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `users` (
  `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  `username`             VARCHAR(64)  UNIQUE NOT NULL,
  `password_hash`        VARCHAR(255) NOT NULL,
  `role_id`              BIGINT NOT NULL,
  `status`               ENUM('active','banned','frozen','pending') NOT NULL DEFAULT 'active',
  `email`                VARCHAR(128) DEFAULT NULL,
  `invite_code`          VARCHAR(32)  UNIQUE DEFAULT NULL,
  `invited_by`           BIGINT DEFAULT NULL,
  `must_change_password` TINYINT(1)   NOT NULL DEFAULT 1,
  `status_reason`        VARCHAR(255) DEFAULT NULL,
  `status_until`         DATETIME     DEFAULT NULL,
  `last_login_at`        DATETIME     DEFAULT NULL,
  `created_at`           DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_users_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 全局业务配置（可热改）：邀请奖励、注册赠送额、限流开关等
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `config_kv` (
  `k`          VARCHAR(64) PRIMARY KEY,
  `v`          JSON NOT NULL,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 订阅档位（Pro / Pro+ / Max / Ultra / Power）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `tiers` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `code`          VARCHAR(32) UNIQUE NOT NULL,
  `display_name`  VARCHAR(64) NOT NULL,
  `price_usd`     DECIMAL(10,2) NOT NULL,
  `quota_5h_usd`  DECIMAL(10,2) NOT NULL,
  `quota_7d_usd`  DECIMAL(10,2) NOT NULL,
  `multiplier`    DECIMAL(6,2) DEFAULT 1.0,
  `features`      JSON,
  `enabled`       TINYINT(1)  NOT NULL DEFAULT 1,
  `sort_order`    INT         NOT NULL DEFAULT 0,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 激活码（角色 / USD 额度 / token 额度）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `activation_codes` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `code`         VARCHAR(64) UNIQUE NOT NULL,
  `code_type`    ENUM('role','quota_usd','quota_token') NOT NULL,
  `payload`      JSON NOT NULL,
  `expires_at`   DATETIME DEFAULT NULL,
  `redeemed_by`  BIGINT DEFAULT NULL,
  `redeemed_at`  DATETIME DEFAULT NULL,
  `batch_id`     VARCHAR(32) DEFAULT NULL,
  `created_by`   BIGINT NOT NULL,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_codes_batch` (`batch_id`),
  INDEX `idx_codes_redeemed` (`redeemed_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 用户订阅记录
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_subscriptions` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`    BIGINT NOT NULL,
  `tier_id`    BIGINT NOT NULL,
  `started_at` DATETIME NOT NULL,
  `expires_at` DATETIME NOT NULL,
  `source`     ENUM('code','admin') NOT NULL DEFAULT 'code',
  `code_id`    BIGINT DEFAULT NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sub_user_time` (`user_id`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 用户额度池：奖励额度（优先扣）+ 基础订阅额度
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_quota` (
  `user_id`              BIGINT PRIMARY KEY,
  `bonus_remaining_usd`  DECIMAL(12,4) NOT NULL DEFAULT 0,
  `base_remaining_usd`   DECIMAL(12,4) NOT NULL DEFAULT 0,
  `total_consumed_usd`   DECIMAL(12,4) NOT NULL DEFAULT 0,
  `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 用量日志（每次代理转发的真实消耗）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `usage_logs` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`       BIGINT NOT NULL,
  `model`         VARCHAR(64) NOT NULL,
  `input_tokens`  BIGINT DEFAULT 0,
  `output_tokens` BIGINT DEFAULT 0,
  `cost_usd`      DECIMAL(12,6) DEFAULT 0,
  `pool`          ENUM('bonus','base') NOT NULL,
  `source`        ENUM('local','official') NOT NULL DEFAULT 'official' COMMENT 'local=本机代理 official=服务端渠道',
  `latency_ms`    INT NOT NULL DEFAULT 0 COMMENT '上游响应耗时（毫秒）',
  `channel_id`    BIGINT DEFAULT NULL COMMENT 'official 路径下记录命中的 channel.id',
  `request_id`    VARCHAR(64) DEFAULT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_user_time` (`user_id`, `created_at`),
  INDEX `idx_model_time` (`model`, `created_at`),
  INDEX `idx_usage_source` (`source`),
  INDEX `idx_usage_channel` (`channel_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 邀请记录
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invitations` (
  `id`                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  `inviter_id`          BIGINT NOT NULL,
  `invitee_id`          BIGINT NOT NULL UNIQUE,
  `reward_inviter_usd`  DECIMAL(10,2) DEFAULT 0,
  `reward_invitee_usd`  DECIMAL(10,2) DEFAULT 0,
  `created_at`          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_inv_inviter` (`inviter_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 用户操作审计（ban / freeze / kick / reset_password）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_actions` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`       BIGINT NOT NULL,
  `action`        ENUM('ban','unban','freeze','unfreeze','kick','reset_password','create','update','delete') NOT NULL,
  `reason`        VARCHAR(255) DEFAULT NULL,
  `duration_secs` INT          DEFAULT NULL COMMENT '-1 = 永久',
  `expires_at`    DATETIME     DEFAULT NULL,
  `operator_id`   BIGINT NOT NULL,
  `metadata`      JSON         DEFAULT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_user_act` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================================
-- 种子数据
-- ============================================================================

-- 默认角色
INSERT INTO `roles` (`id`, `name`, `description`, `is_system`, `permissions`) VALUES
  (1, 'admin', '系统管理员（全部权限）', 1, JSON_ARRAY('*')),
  (2, 'user',  '普通用户（默认）',       1, JSON_ARRAY(
        'self.read','self.update','self.password',
        'invite.create','invite.read.self',
        'code.redeem',
        'usage.read.self',
        'token.read','token.create','token.update','token.delete'
  )),
  (3, 'root',  '超级管理员（站点/支付/SMTP 等系统级配置）', 1, JSON_ARRAY('*'))
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`), `permissions` = VALUES(`permissions`);

-- 默认管理员 admin / 123456 （Argon2id 哈希；首次登录强制改密）
-- 如果你手动执行此 SQL 但希望保持默认密码 123456，可使用下面这个预计算的哈希；
-- 或者跳过此条 INSERT，改用 CCAPI 服务端 UI 上的「初始化数据库」按钮，
-- 它会在 Rust 进程中实时生成 Argon2id 哈希并 UPSERT 此行。
INSERT INTO `users`
  (`id`, `username`, `password_hash`, `role_id`, `status`, `must_change_password`)
VALUES
  (1, 'admin', '$argon2id$v=19$m=19456,t=2,p=1$Y2NhcGlmaXJzdGJvb3Q$U1JxQwt7nVMJ8Wq1mfYGq2PLrcd5dCwm9R4hQp8FZpA', 1, 'active', 1)
ON DUPLICATE KEY UPDATE `username` = VALUES(`username`);

-- 5 档默认订阅
INSERT INTO `tiers`
  (`code`, `display_name`, `price_usd`, `quota_5h_usd`, `quota_7d_usd`, `multiplier`, `sort_order`, `features`)
VALUES
  ('pro',      'Pro 入门版',   5,   10,    67,  1,  10, JSON_OBJECT('access','FRE-5.4 与 FRE-5.5','support','24h email')),
  ('pro_plus', 'Pro+ 标准版',  10,  20,   132,  2,  20, JSON_OBJECT('concurrency','高','support','24h email')),
  ('max',      'Max 专业版',   20,  40,   264,  4,  30, JSON_OBJECT('tools','开发效率工具','support','优先 email')),
  ('ultra',    'Ultra 高级版', 100, 200, 1320, 20,  40, JSON_OBJECT('priority','峰值优先','features','高级特性')),
  ('power',    'Power 旗舰版', 200, 400, 2640, 40,  50, JSON_OBJECT('priority','12h email','features','最高输出'))
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`);

-- 默认全局配置
INSERT INTO `config_kv` (`k`, `v`) VALUES
  ('invite_reward_usd',             JSON_OBJECT('inviter', 10, 'invitee', 10)),
  ('default_signup_bonus_usd',      CAST('10' AS JSON)),
  ('rate_limit_codes_enabled',      JSON_OBJECT('enabled', false)),
  ('rate_limit_global_enabled',     JSON_OBJECT('enabled', true)),
  ('login_rate_per_minute',         CAST('5'  AS JSON)),
  ('api_rate_per_minute',           CAST('6000' AS JSON)),
  -- 第 2 波：站点 / 注册 / 邮件 / 支付 / 敏感词 / 三级速率限制
  ('site_info', JSON_OBJECT(
      'name', 'CCAPI',
      'logoUrl', '',
      'icpRecord', '',
      'footer', 'Powered by CCAPI',
      'announcement', '',
      'updateRepo', 'KingXiaoTaoOVO/ccapi-releases'
   )),
  ('register_policy', JSON_OBJECT(
      'open', true,
      'requireInviteCode', false,
      'requireEmailVerify', false,
      'captchaStrength', 'normal'
   )),
  ('smtp_config', JSON_OBJECT(
      'enabled', false,
      'host', '', 'port', 587, 'username', '',
      'password', '',
      'fromAddress', '', 'fromName', 'CCAPI',
      'useTls', true
   )),
  ('payment_config', JSON_OBJECT(
      'epay', JSON_OBJECT('enabled', false, 'merchantId', '', 'key', '',
                          'gateway', 'https://pay.example.com/submit.php',
                          'notifyUrl', '', 'returnUrl', ''),
      'stripe', JSON_OBJECT('enabled', false, 'publishableKey', '',
                            'secretKey', '', 'webhookSecret', '')
   )),
  ('sensitive_words', JSON_ARRAY()),
  ('rate_limit_per_user_per_minute', CAST('120' AS JSON)),
  ('rate_limit_per_group_per_minute', JSON_OBJECT())
ON DUPLICATE KEY UPDATE `v` = VALUES(`v`);

-- 给默认 admin 一条无限额度记录
INSERT INTO `user_quota` (`user_id`, `bonus_remaining_usd`, `base_remaining_usd`)
VALUES (1, 999999, 999999)
ON DUPLICATE KEY UPDATE `bonus_remaining_usd` = VALUES(`bonus_remaining_usd`);

-- ----------------------------------------------------------------------------
-- 用户分组（差异化计费 + 渠道隔离）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_groups` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `code`          VARCHAR(64) UNIQUE NOT NULL,
  `display_name`  VARCHAR(64) NOT NULL,
  `multiplier`    DECIMAL(6,2) NOT NULL DEFAULT 1.0,
  `description`   VARCHAR(255) DEFAULT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `user_groups` (`id`, `code`, `display_name`, `multiplier`, `description`)
VALUES (1, 'default', '默认分组', 1.0, '所有未指定分组的用户都属于此组')
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`);

-- ----------------------------------------------------------------------------
-- 渠道（对接 AI 服务商上游 — 参考 NewAPI 设计精简）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `channels` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name`            VARCHAR(128) NOT NULL,
  -- openai / anthropic / gemini / custom / local
  `type`            VARCHAR(32)  NOT NULL DEFAULT 'openai',
  `key_encrypted`   TEXT         NOT NULL COMMENT 'API Key（已用 secret_box 加密）',
  `base_url`        VARCHAR(255) DEFAULT NULL,
  `models`          JSON         DEFAULT NULL COMMENT '该渠道支持的模型 ID 列表',
  `model_mapping`   JSON         DEFAULT NULL COMMENT '用户请求模型 → 实际转发模型',
  `param_override`  JSON         DEFAULT NULL COMMENT '简单 / operations 高级模式',
  `priority`        INT          NOT NULL DEFAULT 0  COMMENT '数值越大越优先',
  `weight`          INT          NOT NULL DEFAULT 0  COMMENT '同优先级下的加权随机',
  -- 1 启用 / 0 禁用（自动禁用也会落 0，再附 disabled_reason）
  `status`          TINYINT(1)   NOT NULL DEFAULT 1,
  `disabled_reason` VARCHAR(255) DEFAULT NULL,
  `group_id`        BIGINT       DEFAULT NULL COMMENT '单分组（兼容老 schema，已被 group_ids 取代）',
  `group_ids`       JSON         DEFAULT NULL COMMENT '多对多分组 ID 数组，NULL 或空数组 = 任意分组可用',
  `key_state`       JSON         DEFAULT NULL COMMENT '多 Key 模式运行时状态 {failCounts:[], disabled:[]}',
  `auto_ban`        TINYINT(1)   NOT NULL DEFAULT 1,
  `fail_threshold`  INT          NOT NULL DEFAULT 5,
  `fail_count`      INT          NOT NULL DEFAULT 0,
  `last_test_at`    DATETIME     DEFAULT NULL,
  `last_test_ms`    INT          DEFAULT NULL,
  `last_test_ok`    TINYINT(1)   DEFAULT NULL,
  `tag`             VARCHAR(64)  DEFAULT NULL,
  `created_at`      DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_channels_status` (`status`),
  INDEX `idx_channels_group`  (`group_id`),
  INDEX `idx_channels_tag`    (`tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 模型定价（USD per 1M tokens）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `models` (
  `id`                            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name`                          VARCHAR(128) UNIQUE NOT NULL,
  `display_name`                  VARCHAR(128) DEFAULT NULL,
  `family`                        VARCHAR(64)  DEFAULT NULL COMMENT 'openai / anthropic / gemini / ...',
  `prompt_price_per_million`      DECIMAL(10,4) NOT NULL DEFAULT 3.0000,
  `completion_price_per_million`  DECIMAL(10,4) NOT NULL DEFAULT 15.0000,
  `context_window`                INT          DEFAULT NULL,
  `enabled`                       TINYINT(1)   NOT NULL DEFAULT 1,
  `sort_order`                    INT          NOT NULL DEFAULT 100,
  `created_at`                    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 审计日志（不可被一键清空里的"调用日志"误清；独立表）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
  `actor_id`    BIGINT NOT NULL,
  `actor_name`  VARCHAR(64) DEFAULT NULL,
  `action`      VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(32) DEFAULT NULL,
  `target_id`   BIGINT      DEFAULT NULL,
  `target_name` VARCHAR(255) DEFAULT NULL,
  `payload`     JSON         DEFAULT NULL,
  `created_at`  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_audit_actor` (`actor_id`, `created_at`),
  INDEX `idx_audit_action` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- API 令牌（用户自管，OpenAI 兼容客户端粘贴用）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `api_tokens` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`         BIGINT NOT NULL,
  `name`            VARCHAR(128) NOT NULL,
  -- sha256(明文) 64 字符，做查询用；明文只在创建时返回前端一次
  `key_hash`        CHAR(64) UNIQUE NOT NULL,
  -- 列表展示用（如 sk-ccapi-abcd...wxyz）
  `key_preview`     VARCHAR(48) NOT NULL,
  -- 单 token 总配额（USD）；NULL = 不限
  `quota_usd`       DECIMAL(12,4) DEFAULT NULL,
  `used_usd`        DECIMAL(12,4) NOT NULL DEFAULT 0,
  -- 允许的模型列表（JSON array），NULL = 不限
  `models_allowed`  JSON DEFAULT NULL,
  -- IP / CIDR 白名单，NULL = 不限
  `ip_whitelist`    JSON DEFAULT NULL,
  `expires_at`      DATETIME DEFAULT NULL,
  `revoked`         TINYINT(1) NOT NULL DEFAULT 0,
  `last_used_at`    DATETIME DEFAULT NULL,
  `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_tokens_user` (`user_id`, `revoked`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 2FA（TOTP）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_totp` (
  `user_id`          BIGINT PRIMARY KEY,
  `secret_encrypted` TEXT NOT NULL COMMENT 'Base32 TOTP secret，secret_box 加密',
  `enabled`          TINYINT(1) NOT NULL DEFAULT 0,
  `recovery_hashes`  JSON NOT NULL COMMENT 'sha256(recovery_code) 数组，验过即从数组中删除',
  `created_at`       DATETIME DEFAULT CURRENT_TIMESTAMP,
  `verified_at`      DATETIME DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Passkey / WebAuthn 凭证（最小实现，credential_id 唯一）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_passkeys` (
  `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`        BIGINT NOT NULL,
  `credential_id`  VARCHAR(255) UNIQUE NOT NULL COMMENT 'base64url(rawId)',
  `public_key`     TEXT NOT NULL COMMENT 'COSE public key (base64)',
  `sign_count`     BIGINT NOT NULL DEFAULT 0,
  `nickname`       VARCHAR(64) DEFAULT NULL,
  `last_used_at`   DATETIME DEFAULT NULL,
  `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_passkey_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- OAuth providers + 用户绑定
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `oauth_providers` (
  `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
  `code`            VARCHAR(32) UNIQUE NOT NULL COMMENT 'github / discord / custom1',
  `display_name`    VARCHAR(64) NOT NULL,
  `client_id`       VARCHAR(255) NOT NULL,
  `client_secret_encrypted` TEXT NOT NULL,
  `authorize_url`   VARCHAR(255) NOT NULL,
  `token_url`       VARCHAR(255) NOT NULL,
  `userinfo_url`    VARCHAR(255) NOT NULL,
  `scopes`          VARCHAR(255) DEFAULT '',
  `enabled`         TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_oauth_links` (
  `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`        BIGINT NOT NULL,
  `provider_code`  VARCHAR(32) NOT NULL,
  `external_id`    VARCHAR(128) NOT NULL,
  `external_name`  VARCHAR(128) DEFAULT NULL,
  `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_oauth_external` (`provider_code`, `external_id`),
  INDEX `idx_oauth_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 充值订单（EPay / Stripe / 兑换码统一表）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `recharge_orders` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `order_no`      VARCHAR(64) UNIQUE NOT NULL,
  `user_id`       BIGINT NOT NULL,
  `provider`      ENUM('epay','stripe','manual') NOT NULL,
  `amount_usd`    DECIMAL(10,2) NOT NULL,
  `currency`      VARCHAR(8) NOT NULL DEFAULT 'USD',
  `status`        ENUM('pending','paid','failed','refunded','cancelled') NOT NULL DEFAULT 'pending',
  `external_id`   VARCHAR(128) DEFAULT NULL COMMENT '上游订单/payment_intent id',
  `metadata`      JSON DEFAULT NULL,
  `paid_at`       DATETIME DEFAULT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_orders_user` (`user_id`, `created_at`),
  INDEX `idx_orders_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 异步任务（长任务排队）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `async_tasks` (
  `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`       BIGINT NOT NULL,
  `task_type`     VARCHAR(64) NOT NULL COMMENT 'image_gen / video_gen / data_export ...',
  `status`        ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  `payload`       JSON DEFAULT NULL,
  `result`        JSON DEFAULT NULL,
  `error`         TEXT DEFAULT NULL,
  `progress`      INT NOT NULL DEFAULT 0,
  `started_at`    DATETIME DEFAULT NULL,
  `finished_at`   DATETIME DEFAULT NULL,
  `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_task_user` (`user_id`, `created_at`),
  INDEX `idx_task_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 多租户：organizations（组织）+ organization_members（成员）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `organizations` (
  `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
  `name`           VARCHAR(128) UNIQUE NOT NULL,
  `display_name`   VARCHAR(128) NOT NULL,
  `owner_user_id`  BIGINT NOT NULL,
  `billing_email`  VARCHAR(128) DEFAULT NULL,
  `status`         ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `description`    VARCHAR(255) DEFAULT NULL,
  `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_orgs_owner` (`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `organization_members` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `org_id`     BIGINT NOT NULL,
  `user_id`    BIGINT NOT NULL,
  `role`       ENUM('owner','admin','member') NOT NULL DEFAULT 'member',
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_org_member` (`org_id`, `user_id`),
  INDEX `idx_org_member_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 每日签到（送额度）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `daily_checkins` (
  `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`    BIGINT NOT NULL,
  `checked_on` DATE NOT NULL,
  `reward_usd` DECIMAL(10,4) NOT NULL DEFAULT 0.10,
  `streak`     INT NOT NULL DEFAULT 1,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_checkin_day` (`user_id`, `checked_on`),
  INDEX `idx_checkin_user` (`user_id`, `checked_on`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Prefill 提示词分组（管理员预设 prompt 模板，给用户在 Playground 一键填入）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `prefill_groups` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `code`         VARCHAR(64) UNIQUE NOT NULL,
  `display_name` VARCHAR(128) NOT NULL,
  `description`  VARCHAR(255) DEFAULT NULL,
  `prompts`      JSON NOT NULL COMMENT '[{role:"system|user|assistant", content:"..."}]',
  `enabled`      TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order`   INT NOT NULL DEFAULT 0,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- 自动续费开关（嫁接到 user_subscriptions 上的小补丁；用单独的简单表）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `subscription_auto_renew` (
  `user_id`     BIGINT PRIMARY KEY,
  `tier_id`     BIGINT NOT NULL,
  `enabled`     TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 默认模型种子（与 quota_hook.rs::price_for 的估算一致）
INSERT INTO `models` (`name`, `display_name`, `family`,
   `prompt_price_per_million`, `completion_price_per_million`, `context_window`, `sort_order`) VALUES
  ('claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', 'anthropic',  3.00,  15.00, 200000, 10),
  ('claude-3-5-haiku-20241022',  'Claude 3.5 Haiku',  'anthropic',  0.80,   4.00, 200000, 20),
  ('claude-3-opus-20240229',     'Claude 3 Opus',     'anthropic', 15.00,  75.00, 200000, 30),
  ('gpt-4o',                     'GPT-4o',            'openai',     2.50,  10.00, 128000, 40),
  ('gpt-4o-mini',                'GPT-4o mini',       'openai',     0.15,   0.60, 128000, 50),
  ('gpt-3.5-turbo',              'GPT-3.5 Turbo',     'openai',     0.50,   1.50,  16385, 60)
ON DUPLICATE KEY UPDATE `display_name` = VALUES(`display_name`);
