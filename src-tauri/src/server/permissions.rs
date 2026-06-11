/// 所有可分配权限点（前后端共用 - 必须与 src/types/permissions.ts 保持同步）
pub const ALL_PERMISSIONS: &[(&str, &str)] = &[
    // 自助
    ("self.read", "查看自己资料"),
    ("self.update", "修改自己资料"),
    ("self.password", "修改自己密码"),
    // 用户
    ("user.read", "查看用户列表"),
    ("user.create", "创建用户"),
    ("user.update", "修改用户"),
    ("user.delete", "删除用户"),
    ("user.ban", "封禁用户"),
    ("user.freeze", "冻结用户"),
    ("user.kick", "踢出用户登录"),
    ("user.reset_password", "重置用户密码"),
    // 角色
    ("role.read", "查看角色"),
    ("role.create", "创建角色"),
    ("role.update", "修改角色"),
    ("role.delete", "删除角色"),
    // 激活码
    ("code.read", "查看激活码"),
    ("code.create", "生成激活码"),
    ("code.delete", "删除激活码"),
    ("code.export", "导出激活码"),
    ("code.redeem", "兑换激活码"),
    // 档位
    ("tier.read", "查看档位"),
    ("tier.update", "修改档位"),
    // 用量
    ("usage.read.all", "查看所有用户用量"),
    ("usage.read.self", "查看自己用量"),
    ("usage.delete.all", "清空全站用量记录（一键清空）"),
    // 配置
    ("config.read", "查看服务端业务配置"),
    ("config.write", "修改服务端业务配置"),
    // 邀请
    ("invite.create", "生成邀请链接"),
    ("invite.read.all", "查看所有邀请记录"),
    ("invite.read.self", "查看自己的邀请记录"),
    ("invite.delete.all", "清空全站邀请记录"),
    // 审计日志（一键清空）
    ("log.read.all", "查看审计/调用日志"),
    ("log.delete.all", "清空全站调用日志"),
    // 渠道
    ("channel.read", "查看渠道"),
    ("channel.create", "新建渠道"),
    ("channel.update", "修改渠道"),
    ("channel.delete", "删除渠道"),
    ("channel.test", "测试渠道连通性"),
    // 模型定价
    ("model.read", "查看模型定价"),
    ("model.update", "修改模型定价"),
    ("model.delete", "删除模型"),
    // 用户分组
    ("user_group.read", "查看用户分组"),
    ("user_group.update", "修改用户分组"),
    // API 令牌（用户自管）
    ("token.read", "查看自己的 API 令牌"),
    ("token.create", "创建 API 令牌"),
    ("token.update", "修改 API 令牌"),
    ("token.delete", "撤销 / 删除 API 令牌"),
    // 管理员 token 全站运营
    ("token.read.all", "查看全站 API 令牌"),
    ("token.delete.all", "强制撤销任意 API 令牌"),
    // 审计日志
    ("audit.read", "查看审计日志"),
    ("audit.delete", "清空审计日志"),
];

#[allow(dead_code)]
pub fn permission_keys() -> Vec<&'static str> {
    ALL_PERMISSIONS.iter().map(|(k, _)| *k).collect()
}
