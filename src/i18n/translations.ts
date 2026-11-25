import type {
  AmmoPackId,
  ControllerConfig,
  DailyMissionObjectiveKind,
  GadgetId,
  GameModeId,
  MapId,
  PlatformType,
  RobotClass,
  TeamId,
  VoiceChannel,
  WeaponId,
} from '../shared/types';

export type Language = 'zh' | 'en';

export const ACTION_BINDING_LABELS: Record<
  Language,
  Record<keyof ControllerConfig['bindings'], string>
> = {
  zh: {
    fire: '射击 / 采矿',
    ads: '精确瞄准',
    dash: '推进冲刺',
    gadget: '战术模块',
    classSkill: '专属技能',
    buyAmmo: '快捷购弹',
    reload: '快速散热',
    voicePtt: '按键说话',
  },
  en: {
    fire: 'Fire / Mine',
    ads: 'Aim Down Sight',
    dash: 'Thruster Dash',
    gadget: 'Tactical Gadget',
    classSkill: 'Class Skill / Mine',
    buyAmmo: 'Quick Buy Ammo',
    reload: 'Vent Heat',
    voicePtt: 'Voice PTT',
  },
};

export const ROBOT_CLASS_I18N: Record<
  Language,
  Record<
    RobotClass,
    {
      shortName: string;
      hudName: string;
      name: string;
      role: string;
      summary: string;
      titleSub: string;
      classSkillName: string;
    }
  >
> = {
  zh: {
    s1_striker: {
      shortName: 'S1 突击手',
      hudName: 'S1 突击手',
      name: 'RoboMaster S1 突击手',
      role: '突击作战单位 · 双轴发射器',
      summary: '高机动麦克纳姆轮战车，搭载精准双轴云台激光发射器。需消耗团队经济购买弹药。',
      titleSub: '100 装甲 · 高速云台',
      classSkillName: '超频过载',
    },
    ep_miner: {
      shortName: 'EP 工程兵',
      hudName: 'EP 工程车',
      name: 'RoboMaster EP 工程机器人',
      role: '无武装采矿支援 · 机械臂',
      summary: '重装甲工程底盘，无弹药发射器无法开火，但采集矿脉速度达 3 倍，为全队赚取经济并提供群体护盾修复。',
      titleSub: '135 装甲 · 无武装 3x 采矿',
      classSkillName: '涡轮采矿脉冲',
    },
  },
  en: {
    s1_striker: {
      shortName: 'S1 Striker',
      hudName: 'S1 Striker',
      name: 'RoboMaster S1 Striker',
      role: 'Assault Combatant · 2-Axis Blaster',
      summary: 'High-mobility Mecanum rover with precision gimbal laser turret. Spends Team Credits to resupply ammo.',
      titleSub: '100 HP · Fast Gimbal',
      classSkillName: 'Overclock Surge',
    },
    ep_miner: {
      shortName: 'EP Engineer',
      hudName: 'EP Miner',
      name: 'RoboMaster EP Engineer',
      role: 'Unarmed Harvester · Robotic Arm',
      summary: 'Heavy armored engineer chassis without a blaster. Cannot fire bullets — mines Ore Veins at 3x speed to fund Team Credits and pulses ally shield repairs.',
      titleSub: '135 HP · Unarmed 3x Miner',
      classSkillName: 'Turbo Extraction',
    },
  },
};

export const WEAPON_I18N: Record<
  Language,
  Record<WeaponId, { name: string; role: string }>
> = {
  zh: {
    pulse_carbine: { name: '脉冲卡宾发射器', role: '高速连发 · 30 发弹匣' },
    prism_railgun: { name: '棱镜磁轨炮', role: '高能狙击 · 10 发弹匣' },
    scatter_projector: { name: '散射棱镜炮', role: '多束散射 · 18 发弹匣' },
  },
  en: {
    pulse_carbine: { name: 'Pulse Carbine', role: 'Rapid Auto · 30 Rd Mag' },
    prism_railgun: { name: 'Prism Railgun', role: 'High-Velocity · 10 Rd Mag' },
    scatter_projector: { name: 'Scatter Projector', role: 'Multi-Beam · 18 Rd Mag' },
  },
};

export const GADGET_I18N: Record<
  Language,
  Record<GadgetId, { name: string; role: string }>
> = {
  zh: {
    phase_dash: { name: '相位推进器', role: '定向突进 · 移速暴增' },
    aegis_wall: { name: '宙斯盾脉冲护盾', role: '吸收 55% 受到的伤害' },
    emp_pulse: { name: '电弧干扰脉冲', role: '削弱附近敌方护盾 · 11米' },
  },
  en: {
    phase_dash: { name: 'Phase Thruster', role: 'Directional Surge · +Speed' },
    aegis_wall: { name: 'Aegis Pulse Shield', role: 'Absorbs 55% Incoming Damage' },
    emp_pulse: { name: 'Arc Disruptor', role: 'Strips Nearby Shields · 11m' },
  },
};

export const AMMO_PACK_I18N: Record<
  Language,
  Record<AmmoPackId, { name: string; shortLabel: string }>
> = {
  zh: {
    light_mag: { name: '战术弹药单元', shortLabel: '+15 弹药' },
    full_mag: { name: '满弹匣补充', shortLabel: '满弹匣' },
    combat_resupply: { name: '战场补给 + 维修', shortLabel: '弹药 + 维修' },
    overcharge_cell: { name: '超载补给舱', shortLabel: '超载补给' },
  },
  en: {
    light_mag: { name: 'Tactical Ammo Cell', shortLabel: '+15 Ammo' },
    full_mag: { name: 'Full Magazine Refill', shortLabel: 'Full Mag' },
    combat_resupply: { name: 'Combat Resupply + Repair', shortLabel: 'Ammo + HP' },
    overcharge_cell: { name: 'Overcharge Supply Pod', shortLabel: 'Overcharge' },
  },
};

export const COSMETIC_NAME_ZH: Record<string, string> = {
  beam_cyan: '钴蓝脉冲',
  beam_amber: '太阳琥珀',
  beam_emerald: '翡翠涌流',
  beam_crimson: '绯红新星',
  beam_prismatic: '棱镜纯白',
  skin_graphite: '碳素哑光',
  skin_titanium: '拉丝钛金',
  skin_cobalt: '阳极钴蓝',
  skin_sovereign: '烈阳主宰',
  emblem_prism: '矢量棱镜',
  emblem_apex: '巅峰折角',
  emblem_nova: '新星核心',
};

export const MAP_I18N: Record<Language, Record<MapId, { name: string; subtitle: string }>> = {
  zh: {
    reactor_foundry: {
      name: '反应堆铸造厂',
      subtitle: '工业核心 · 金矿脉与激光扫描通道',
    },
    cryo_relay: {
      name: '极寒中继站',
      subtitle: '极低温阵列 · 冰晶矿脉与棱镜高塔',
    },
  },
  en: {
    reactor_foundry: {
      name: 'Reactor Foundry',
      subtitle: 'Industrial Core · Aurum Ore Veins & Sweeper Lanes',
    },
    cryo_relay: {
      name: 'Cryo Relay',
      subtitle: 'Sub-Zero Array · Cryo Crystals & Prism Towers',
    },
  },
};

export const MODE_I18N: Record<Language, Record<GameModeId, { full: string; short: string }>> = {
  zh: {
    team_clash: { full: '团队激光对抗 (3v3)', short: '团队对抗' },
    control_core: { full: '核心争夺 (区域控制)', short: '核心争夺' },
    ffa: { full: '个人自由混战', short: '个人混战' },
  },
  en: {
    team_clash: { full: 'Team Laser Clash (3v3)', short: 'Team Clash' },
    control_core: { full: 'Control Core (Zone Hold)', short: 'Control Core' },
    ffa: { full: 'Free-For-All', short: 'FFA' },
  },
};

export const VOICE_CHANNEL_LABELS: Record<Language, Record<VoiceChannel, string>> = {
  zh: {
    team: '队伍频道',
    squad: '小队频道',
    proximity: '近距离语音',
    muted: '静音',
  },
  en: {
    team: 'Team',
    squad: 'Squad',
    proximity: 'Proximity',
    muted: 'Muted',
  },
};

export const PLATFORM_LABELS: Record<Language, Record<PlatformType, string>> = {
  zh: {
    pc: 'PC 端',
    console: '主机端',
    cloud: '云游戏',
  },
  en: {
    pc: 'PC',
    console: 'Console',
    cloud: 'Cloud',
  },
};

const SKILL_TIER_ZH: Record<string, string> = {
  'Bronze Vector': '青铜矢量',
  'Silver Pulse': '白银脉冲',
  'Cobalt Vanguard': '钴蓝先锋',
  'Amber Prism': '琥珀棱镜',
  'Apex Sovereign': '巅峰主宰',
};

const XP_RANK_ZH: Record<string, string> = {
  Initiate: '新兵列兵',
  Vector: '矢量专员',
  Vanguard: '战术先锋',
  'Prism Knight': '棱镜骑士',
  'Apex Sovereign': '巅峰主宰',
};

const ORE_LABEL_ZH: Record<string, string> = {
  'West Aurum Vein': '西侧金矿脉',
  'East Aurum Vein': '东侧金矿脉',
  'North High-Yield Vein': '北侧高产富矿脉',
  'South High-Yield Vein': '南侧高产富矿脉',
  'Southwest Seam': '西南矿层',
  'Northeast Seam': '东北矿层',
  'West Cryo Vein': '西侧冰晶矿脉',
  'East Cryo Vein': '东侧冰晶矿脉',
  'North Rich Vein': '北侧富矿脉',
  'South Rich Vein': '南侧富矿脉',
};

const HAZARD_LABEL_ZH: Record<string, string> = {
  'Plasma Arc Pylon (North)': '等离子电弧塔 (北)',
  'Plasma Arc Pylon (South)': '等离子电弧塔 (南)',
  'Central Laser Sweeper': '中央旋转扫描激光',
  'Cryo Coolant Vent (West)': '极寒冷却液泄口 (西)',
  'Cryo Coolant Vent (East)': '极寒冷却液泄口 (东)',
  'Cryo Breach (North)': '极寒裂隙 (北)',
  'Cryo Breach (South)': '极寒裂隙 (南)',
  'Cryo Array Sweeper': '极寒阵列扫描激光',
  'Relay Capacitor (West)': '中继电容塔 (西)',
  'Relay Capacitor (East)': '中继电容塔 (东)',
};

const DYNAMIC_TEXT_ZH: Record<string, string> = {
  'Pulse Carbine': '脉冲卡宾',
  'Prism Railgun': '棱镜磁轨炮',
  'Scatter Projector': '散射棱镜炮',
  'Cobalt Squad': '钴蓝小队',
  'Amber Squad': '琥珀小队',
  Draw: '平局',
  'Top Operative': '最佳操作手',
  'Public Alpha · Reactor Foundry': '公开大厅 Alpha · 反应堆铸造厂',
  'Cryo Relay Skirmish': '极寒中继站遭遇战',
  'Control Core Ranked': '核心争夺排位赛',
  ...HAZARD_LABEL_ZH,
  ...ORE_LABEL_ZH,
};

export function translateSkillTier(label: string, lang: Language): string {
  if (lang === 'en') return label;
  return SKILL_TIER_ZH[label] ?? label;
}

export function translateXpRank(name: string, lang: Language): string {
  if (lang === 'en') return name;
  return XP_RANK_ZH[name] ?? name;
}

export function translateOreLabel(label: string, lang: Language): string {
  if (lang === 'en') return label;
  return ORE_LABEL_ZH[label] ?? label;
}

export function translateHazardLabel(label: string, lang: Language): string {
  if (lang === 'en') return label;
  return HAZARD_LABEL_ZH[label] ?? label;
}

export function translateDynamicLabel(label: string, lang: Language): string {
  if (lang === 'en') return label;
  return DYNAMIC_TEXT_ZH[label] ?? label;
}

export function translateCosmeticName(id: string, fallbackEn: string, lang: Language): string {
  if (lang === 'en') return fallbackEn;
  return COSMETIC_NAME_ZH[id] ?? fallbackEn;
}

export function translateTeamName(team: TeamId | 'cobalt' | 'amber', lang: Language): string {
  if (lang === 'en') return team === 'amber' ? 'Amber' : 'Cobalt';
  return team === 'amber' ? '琥珀队' : '钴蓝队';
}

export function translateControlOwner(owner: string, lang: Language): string {
  if (lang === 'en') return owner.toUpperCase();
  if (owner === 'cobalt') return '钴蓝队占领';
  if (owner === 'amber') return '琥珀队占领';
  if (owner === 'contested') return '争夺中';
  return '中立';
}

export type EngineAlertKey =
  | 'ep_unarmed_credits'
  | 'insufficient_credits'
  | 'resupplied'
  | 'ep_no_weapon'
  | 'low_team_credits'
  | 'already_full'
  | 'no_ammo'
  | 'supply_unavailable'
  | 'ep_unarmed_mine'
  | 'ep_unarmed_harvest'
  | 'turbo_extraction'
  | 'overclock_surge';

export function formatEngineAlert(
  key: EngineAlertKey,
  lang: Language,
  packId?: AmmoPackId,
): string {
  if (lang === 'zh') {
    switch (key) {
      case 'ep_unarmed_credits':
        return 'EP 工程车无武装 · 经济用于支援友军 S1';
      case 'insufficient_credits':
        return '团队经济不足 · 请靠近矿脉采矿';
      case 'resupplied': {
        const packName = packId ? AMMO_PACK_I18N.zh[packId]?.shortLabel : '弹药';
        return `补给完成 · ${packName}`;
      }
      case 'ep_no_weapon':
        return 'EP 工程机器人无发射器 · 不可发射子弹';
      case 'low_team_credits':
        return '团队经济过低 · 请部署 EP 工程车采矿';
      case 'already_full':
        return '弹药与装甲已处于满状态';
      case 'no_ammo':
        return '弹匣已空 · 按 [B] 购买弹药';
      case 'supply_unavailable':
        return '当前无法进行补给';
      case 'ep_unarmed_mine':
        return 'EP 无武装 · 长按 [E] 或左键采集矿石';
      case 'ep_unarmed_harvest':
        return 'EP 工程车无武装 · 按 [E] 采集矿脉';
      case 'turbo_extraction':
        return '涡轮采矿激活 + 友军护盾修复脉冲';
      case 'overclock_surge':
        return '超频过载激活 · 射速提升并清空热量';
    }
  } else {
    switch (key) {
      case 'ep_unarmed_credits':
        return 'EP UNARMED · CREDITS FUND TEAM S1';
      case 'insufficient_credits':
        return 'INSUFFICIENT CREDITS · MINE ORE';
      case 'resupplied': {
        const packName = packId ? AMMO_PACK_I18N.en[packId]?.shortLabel : 'AMMO';
        return `RESUPPLIED · ${packName.toUpperCase()}`;
      }
      case 'ep_no_weapon':
        return 'EP ENGINEER UNARMED · NO BLASTER';
      case 'low_team_credits':
        return 'LOW TEAM CREDITS · DEPLOY EP MINER';
      case 'already_full':
        return 'AMMO & HULL ALREADY FULL';
      case 'no_ammo':
        return 'MAGAZINE EMPTY · PRESS [B] TO BUY';
      case 'supply_unavailable':
        return 'SUPPLY UNAVAILABLE';
      case 'ep_unarmed_mine':
        return 'EP UNARMED · HOLD [E] OR LMB TO MINE';
      case 'ep_unarmed_harvest':
        return 'EP ENGINEER UNARMED · HARVEST ORE [E]';
      case 'turbo_extraction':
        return 'TURBO EXTRACTION + REPAIR PULSE';
      case 'overclock_surge':
        return 'OVERCLOCK SURGE ACTIVE';
    }
  }
}

export const UI_TEXT = {
  zh: {
    pageTitle: '棱镜突破 — 机甲战术竞技场',
    // TitleOverlay
    linking: '连接中...',
    titleSubtitle: '机甲战术竞技场 · 封闭测试',
    titleDesc:
      '驾驶全向机动 RoboMaster S1 突击手，或部署关节机械臂 RoboMaster EP 工程机器人采集矿脉、赚取全队弹药经济，制霸动态反应堆竞技场。',
    deployChassisUnit: '选择出战机甲单位',
    enterArena: '进入战场',
    armory: '军械库',
    matchmakingVoice: '匹配与语音',
    careerTelemetry: '生涯战绩',
    controlsPad: '控制与设置',
    dailyMissions: '每日任务',
    dailyMissionsReady: (n: number) => `${n} 项可领取`,
    titleHints:
      'WASD 移动 · 鼠标瞄准 · 左键射击 · Shift 冲刺 · Q 战术模块 · E 技能/采矿 · B 买弹药 · U 切换 S1/EP',
    // GameHud
    copied: '已复制',
    copyCode: '复制房间码',
    you: '你',
    leader: '领先者',
    leadPrefix: '领先',
    creditsSuffix: '积分',
    teamCreditsLabel: (team: TeamId) => (team === 'amber' ? '琥珀队经济' : '钴蓝队经济'),
    corePrefix: '核心',
    hazardAlertPrefix: '危险警报',
    hazardCharging: '蓄能预警',
    hazardActive: '高能激活',
    lockAim: '锁定准星',
    voiceChannelAria: '语音频道',
    muteAudio: '静音',
    unmuteAudio: '取消静音',
    pauseGame: '暂停游戏',
    chassisDisabled: '机甲底盘受损离线',
    redeployingIn: (sec: number) => `重新部署倒计时 ${sec} 秒`,
    squadChat: '小队聊天',
    messageSquadPlaceholder: '发送小队消息...',
    voicePrefix: '语音',
    hull: '装甲',
    shield: '护盾',
    kdShort: '击杀/死亡',
    overclockStatus: (sec: number) => `超频过载 ${sec}s`,
    aegisActive: '宙斯盾激活',
    cryoSlowed: '低温减速',
    nominal: '运行正常',
    extractingOre: '正在采集矿脉',
    holdToExtract: '长按 [E] 采集矿脉',
    ready: '就绪',
    thrusterDash: '推进冲刺',
    buyFullMag: '购买满弹匣',
    minerTag: '工程采矿',
    miningRate: '36 积分/秒',
    unarmedSupport: '无武装支援',
    overheatReload: '过热 [R]',
    heatLabel: '热量',
    epRigTitle: 'EP 工程机械臂',
    unarmedBadge: '无武装',
    epRigDesc:
      '无激光发射器，不可发射子弹。靠近矿脉长按 [E] 或左键即可采矿，为队友 S1 突击手提供弹药经济。按 [U] 切换机甲。',
    hullShieldRepair: '装甲 + 护盾修复',
    pingLabel: '延迟',
    antiCheatLabel: '反作弊',
    antiCheatVerified: '已验证',
    antiCheatActive: '运行中',
    padActive: '手柄已激活',
    killFeedAria: '实时击杀与阵亡播报',
    killFeedElimTag: '击杀',
    killFeedDownTag: '阵亡',
    killFeedHazardTag: '环境',
    minimapAria: '实时战术小地图',
    minimapHazardActive: (n: number) => `${n} 危险激活`,
    minimapHazardWarn: (n: number) => `${n} 危险预警`,
    minimapClear: '区域安全',
    // PauseModal
    matchPaused: '比赛已暂停',
    pauseDesc: '服务器上的机甲大师竞技场仍在实时运行中。',
    resumeMatch: '返回战场',
    deployUnitPrefix: '切换部署',
    armoryCosmetics: '军械库与涂装',
    controlsSensitivity: '控制与灵敏度',
    leaveToTitle: '返回主界面',
    // GameOverModal
    matchComplete: '比赛结束',
    victorySecured: '取得胜利',
    rankPlacement: (place: number, winner: string) => `排名第 #${place} · 胜者: ${winner}`,
    kdHeader: '击杀 / 死亡',
    accuracyHeader: '命中率',
    mmrDeltaHeader: 'MMR 变化',
    rankLabel: '军衔',
    playAgain: '再来一局',
    backTitle: '主界面',
    // LoadoutModal
    armoryTitle: '机甲军械库与底盘整备',
    careerCreditsSuffix: '生涯积分',
    currentTier: '当前军衔',
    nextTier: (name: string, minXp: number) => `下一级: ${name} (${minXp} XP)`,
    maxTierReached: '已达最高军衔',
    chassisPlatformTitle: 'RoboMaster 机甲底盘平台 [U]',
    hullLabel: '装甲',
    shieldStatLabel: '护盾',
    unarmedTag: '无武装',
    mineRateLabel: '采矿',
    primaryEmitterTitle: '主激光发射器',
    damageShort: '伤害',
    unlocked: '已解锁',
    tacticalModuleTitle: '战术模块 [Q]',
    cooldownLabel: '冷却',
    beamSpectrum: '激光光束光谱',
    armorFinish: '装甲涂装材质',
    operativeEmblem: '操作手徽章',
    equipped: '已装备',
    equip: '装备',
    closeArmory: '关闭军械库',
    // SocialLobbyModal
    socialTitle: '排位匹配、私人房间与语音通讯',
    activeRoom: '当前房间',
    skillBracket: '竞技段位',
    tabMatchmake: '排位匹配与大厅',
    tabPrivate: '私人房间',
    tabFriends: '好友与语音通讯',
    sbmmTitle: '技术分级匹配 (SBMM)',
    gameMode: '游戏模式',
    preferredArena: '首选竞技场',
    crossplayPool: '跨平台匹配池 (PC · 主机 · 云端)',
    findRankedMatch: (mmr: number) => `开始排位匹配 (${mmr} MMR)`,
    searchingLobby: '正在搜索实力均衡房间... 点击取消',
    liveServers: '在线公开服务器',
    operativesUnit: '名玩家',
    activeRoomBtn: '当前所在',
    deployRoomBtn: '进入',
    createPrivateTitle: '创建私人房间',
    lobbyName: '房间名称',
    defaultPrivateName: (callsign: string) => `${callsign} 的竞技场`,
    arenaMap: '竞技场地图',
    modeLabel: '模式',
    hazardIntensity: '环境危险强度',
    hazardStandard: '标准',
    hazardOverdrive: '超载 (+35%)',
    friendlyFire: '友军伤害',
    createAndDeploy: '创建并进入战场',
    privateRoomCreated: '已创建私人房间:',
    shareCodeHint: '将此房间码分享给好友即可加入',
    joinByCodeTitle: '通过房间码加入',
    joinByCodeDesc: '输入来自 PC、主机或云端好友的邀请码，直接空降加入私人竞技场。',
    roomCodeLabel: '房间码',
    joinPrivateLobby: '加入私人房间',
    enterRoomCodeErr: '请输入房间码（例如 PRISM-XXXX）',
    lobbyNotFoundErr: '未找到对应房间码',
    networkCheckErr: '校验房间码时网络出错',
    createLobbyErr: '无法创建私人房间',
    friendsRoster: '好友列表',
    operativesCount: (n: number) => `${n} 位好友`,
    addCallsignPlaceholder: '输入好友代号...',
    addFriendBtn: '添加',
    cannotAddSelf: '不能添加自己的代号。',
    friendAdded: '已将该操作手加入好友列表。',
    friendExists: '该操作手已在你的好友列表中。',
    friendAddFail: '无法添加该好友。',
    friendNetErr: '添加好友时连接异常。',
    joinFriendMatch: '加入对局',
    friendReady: '在线就绪',
    friendOffline: '离线',
    friendStatusOnline: '在线',
    friendStatusInMatch: '对战中',
    friendStatusInLobby: '大厅中',
    friendStatusOffline: '离线',
    webrtcVoiceTitle: 'WebRTC 实时语音通讯',
    micActive: '麦克风已开启',
    micStandby: '待机中',
    voiceChannelLabel: '语音频道',
    transmissionMode: '发射模式',
    pttMode: '按键说话 [V]',
    openMicMode: '自由麦',
    micConnected: '麦克风已连接',
    enableMic: '启用麦克风语音',
    // StatsModal
    statsTitle: '生涯战绩与竞技统计',
    winRate: '胜率',
    winsLosses: (w: number, l: number) => `${w} 胜 · ${l} 负`,
    kdRatio: 'K / D 比',
    eliminations: (n: number) => `${n} 次淘汰`,
    laserAccuracy: '激光命中率',
    hitsRatio: (h: number, f: number) => `${h}/${f} 命中`,
    destructionHazards: '掩体破坏与环境助攻',
    hazardAssists: (n: number) => `${n} 次环境击杀/助攻`,
    emitterMastery: '发射器专精统计',
    totalDmg: (d: number) => `${d} 总伤害`,
    killsCount: (k: number) => `${k} 淘汰`,
    accShort: (a: number) => `${a}% 命中`,
    serverAuthorityTitle: '服务器权威校验与反作弊',
    serverRtt: '服务器延迟 (RTT)',
    packetsAudited: '已校验数据包',
    speedClamps: '移动位置修正',
    rateLosBlocks: '频率 / 视线拦截',
    recentHistory: '近期战绩记录',
    winBadge: '胜',
    lossBadge: '负',
    noMatchesYet: '暂无比赛记录，快进入战场开始首局对战吧！',
    // SettingsModal
    settingsTitle: '控制与视角设置',
    settingsDesc: '自定义界面语言、鼠标与手柄灵敏度曲线、按键绑定及玩家档案。',
    languageSection: '界面语言 / Language',
    languageDesc: '即时切换游戏界面、提示与播报的显示语言。',
    operativeProfileTitle: '操作手档案',
    callsignLabel: '操作手代号',
    saveBtn: '保存',
    activePlatform: '当前平台标识',
    enableCrossplay: '启用跨平台联机匹配',
    mouseReticleTitle: '鼠标与准星',
    mouseSensitivity: '鼠标灵敏度',
    fovLabel: '视野范围 (FOV)',
    crosshairStyle: '准星样式',
    crosshairPrecision: '精准十字',
    crosshairChevron: '折角准星',
    crosshairRing: '棱镜圆环',
    invertLookY: '反转 Y 轴视角',
    controllerTuningTitle: '手柄与控制器调校',
    padConnected: '手柄已连接',
    noPadDetected: '未检测到手柄',
    gamepadPolling: '启用手柄输入',
    hapticVibration: '震动反馈',
    stickSensitivity: '摇杆视角灵敏度',
    leftDeadzone: '左摇杆死区',
    rightDeadzone: '右摇杆死区',
    actionBindings: '按键绑定',
    resetDefaults: '恢复默认',
    // DailyMissionsModal
    missionsTitle: '每日作战任务',
    missionsSubtitle: '完成每日战术目标，赢取额外生涯积分奖励。',
    missionsResetIn: (hms: string) => `距离重置 ${hms} (UTC)`,
    missionsBalanceLabel: '当前积分余额',
    missionsClaimBtn: (credits: number) => `领取 +${credits} 积分`,
    missionsClaiming: '领取中...',
    missionsClaimed: '已领取',
    missionsInProgress: '进行中',
    missionsCompletedTag: '已完成',
    missionsAllClearTitle: '每日全清奖励',
    missionsAllClearDesc: (done: number, total: number) => `完成今日全部 ${total} 项任务即可领取额外奖励（当前 ${done}/${total}）。`,
    missionsClaimBonusBtn: (credits: number) => `领取全清奖励 +${credits} 积分`,
    missionsRewardReceived: (credits: number) => `已到账 +${credits} 积分`,
    missionsClose: '关闭每日任务',
    missionsProgressSummaryTitle: '每日任务进度更新',
    missionsOpenBtn: '查看每日任务',
  },
  en: {
    pageTitle: 'Prism Breach — Mech Arena',
    // TitleOverlay
    linking: 'Linking...',
    titleSubtitle: 'TACTICAL ARENA · CLOSED TEST',
    titleDesc:
      'Pilot an armored RoboMaster S1 Striker or deploy the articulated RoboMaster EP Engineer to harvest ore veins, fund team ammo supply, and dominate reactive arenas.',
    deployChassisUnit: 'Deploy Chassis Unit',
    enterArena: 'Enter Arena',
    armory: 'Armory',
    matchmakingVoice: 'Matchmaking & Voice',
    careerTelemetry: 'Career Telemetry',
    controlsPad: 'Controls & Pad',
    dailyMissions: 'Daily Missions',
    dailyMissionsReady: (n: number) => `${n} Ready`,
    titleHints:
      'WASD Drive · Mouse Aim · LMB Fire · Shift Dash · Q Gadget · E Skill/Mine · B Buy Ammo · U Switch S1/EP',
    // GameHud
    copied: 'Copied',
    copyCode: 'Copy Code',
    you: 'You',
    leader: 'Leader',
    leadPrefix: 'Lead',
    creditsSuffix: 'CR',
    teamCreditsLabel: (team: TeamId) => (team === 'amber' ? 'Amber Credits' : 'Cobalt Credits'),
    corePrefix: 'Core',
    hazardAlertPrefix: 'HAZARD ALERT',
    hazardCharging: 'CHARGING',
    hazardActive: 'ACTIVE',
    lockAim: 'Lock Aim',
    voiceChannelAria: 'Voice Channel',
    muteAudio: 'Mute Audio',
    unmuteAudio: 'Unmute Audio',
    pauseGame: 'Pause Game',
    chassisDisabled: 'Chassis Disabled',
    redeployingIn: (sec: number) => `Redeploying in ${sec}s`,
    squadChat: 'Squad Chat',
    messageSquadPlaceholder: 'Message squad...',
    voicePrefix: 'Voice',
    hull: 'Hull',
    shield: 'Shield',
    kdShort: 'K/D',
    overclockStatus: (sec: number) => `OVERCLOCK ${sec}s`,
    aegisActive: 'AEGIS ACTIVE',
    cryoSlowed: 'CRYO SLOWED',
    nominal: 'NOMINAL',
    extractingOre: 'EXTRACTING ORE',
    holdToExtract: 'HOLD [E] EXTRACT ORE',
    ready: 'READY',
    thrusterDash: 'Thruster Dash',
    buyFullMag: 'Buy Full Mag',
    minerTag: 'MINER',
    miningRate: '36 CR/s',
    unarmedSupport: 'Unarmed Support',
    overheatReload: 'OVERHEAT [R]',
    heatLabel: 'HEAT',
    epRigTitle: 'EP Gripper Rig',
    unarmedBadge: 'UNARMED',
    epRigDesc:
      'No projectile blaster. Hold [E] or LMB near Ore Veins to mine Team Credits for S1 Striker ammo. Press [U] to switch units.',
    hullShieldRepair: 'Hull + Shield Repair',
    pingLabel: 'Ping',
    antiCheatLabel: 'Anti-Cheat',
    antiCheatVerified: 'Verified',
    antiCheatActive: 'Active',
    padActive: 'Pad Active',
    killFeedAria: 'Live elimination and death feed',
    killFeedElimTag: 'ELIM',
    killFeedDownTag: 'DOWN',
    killFeedHazardTag: 'HAZARD',
    minimapAria: 'Real-time tactical minimap',
    minimapHazardActive: (n: number) => `${n} HAZARD ACTIVE`,
    minimapHazardWarn: (n: number) => `${n} HAZARD WARN`,
    minimapClear: 'SECTOR CLEAR',
    // PauseModal
    matchPaused: 'Match Paused',
    pauseDesc: 'Arena simulation remains live for active RoboMaster units on the server.',
    resumeMatch: 'Resume Match',
    deployUnitPrefix: 'Deploy',
    armoryCosmetics: 'Armory & Cosmetics',
    controlsSensitivity: 'Controls & Sensitivity',
    leaveToTitle: 'Leave to Title Screen',
    // GameOverModal
    matchComplete: 'Match Complete',
    victorySecured: 'Victory Secured',
    rankPlacement: (place: number, winner: string) => `Rank #${place} · Winner: ${winner}`,
    kdHeader: 'K / D',
    accuracyHeader: 'Accuracy',
    mmrDeltaHeader: 'MMR Delta',
    rankLabel: 'Rank',
    playAgain: 'Play Again',
    backTitle: 'Title',
    // LoadoutModal
    armoryTitle: 'Robotics Armory & Chassis Loadout',
    careerCreditsSuffix: 'Career Credits',
    currentTier: 'Current Tier',
    nextTier: (name: string, minXp: number) => `Next: ${name} (${minXp} XP)`,
    maxTierReached: 'Max Tier Reached',
    chassisPlatformTitle: 'RoboMaster Chassis Platform [U]',
    hullLabel: 'Hull',
    shieldStatLabel: 'Shield',
    unarmedTag: 'Unarmed',
    mineRateLabel: 'Mine',
    primaryEmitterTitle: 'Primary Laser Emitter',
    damageShort: 'DMG',
    unlocked: 'Unlocked',
    tacticalModuleTitle: 'Tactical Rig Module [Q]',
    cooldownLabel: 'Cooldown',
    beamSpectrum: 'Beam Spectrum',
    armorFinish: 'Armor Finish',
    operativeEmblem: 'Operative Emblem',
    equipped: 'Equipped',
    equip: 'Equip',
    closeArmory: 'Close Armory',
    // SocialLobbyModal
    socialTitle: 'Matchmaking, Lobbies & Squad Voice',
    activeRoom: 'Active Room',
    skillBracket: 'Skill Bracket',
    tabMatchmake: 'Ranked SBMM & Arenas',
    tabPrivate: 'Private Lobbies',
    tabFriends: 'Friends & Voice Comms',
    sbmmTitle: 'Skill-Based Matchmaking',
    gameMode: 'Game Mode',
    preferredArena: 'Preferred Arena',
    crossplayPool: 'Cross-Platform Pool (PC · Console · Cloud)',
    findRankedMatch: (mmr: number) => `Find Ranked Match (${mmr} MMR)`,
    searchingLobby: 'Searching Balanced Lobby... Cancel',
    liveServers: 'Live Arena Servers',
    operativesUnit: 'Operatives',
    activeRoomBtn: 'Active',
    deployRoomBtn: 'Deploy',
    createPrivateTitle: 'Create Private Lobby',
    lobbyName: 'Lobby Name',
    defaultPrivateName: (callsign: string) => `${callsign}'s Arena`,
    arenaMap: 'Arena Map',
    modeLabel: 'Mode',
    hazardIntensity: 'Hazard Intensity',
    hazardStandard: 'Standard',
    hazardOverdrive: 'Overdrive (+35%)',
    friendlyFire: 'Friendly Fire',
    createAndDeploy: 'Create & Deploy',
    privateRoomCreated: 'Private Room Created:',
    shareCodeHint: 'Share this code with friends',
    joinByCodeTitle: 'Join by Room Code',
    joinByCodeDesc:
      'Enter an invite code from a friend across PC, Console, or Cloud to deploy directly into their private arena.',
    roomCodeLabel: 'Room Code',
    joinPrivateLobby: 'Join Private Lobby',
    enterRoomCodeErr: 'Enter a room code (e.g. PRISM-XXXX)',
    lobbyNotFoundErr: 'Lobby code not found',
    networkCheckErr: 'Network error checking lobby code',
    createLobbyErr: 'Unable to create lobby',
    friendsRoster: 'Friends Roster',
    operativesCount: (n: number) => `${n} Operatives`,
    addCallsignPlaceholder: 'Add callsign...',
    addFriendBtn: 'Add',
    cannotAddSelf: 'Cannot add your own callsign.',
    friendAdded: 'Operative added to friend roster.',
    friendExists: 'Already on your friend list.',
    friendAddFail: 'Unable to add friend.',
    friendNetErr: 'Connection error adding friend.',
    joinFriendMatch: 'Join Match',
    friendReady: 'Ready',
    friendOffline: 'Offline',
    friendStatusOnline: 'online',
    friendStatusInMatch: 'in match',
    friendStatusInLobby: 'in lobby',
    friendStatusOffline: 'offline',
    webrtcVoiceTitle: 'WebRTC Voice Comms',
    micActive: 'Mic Active',
    micStandby: 'Standby',
    voiceChannelLabel: 'Voice Channel',
    transmissionMode: 'Transmission Mode',
    pttMode: 'Push-to-Talk [V]',
    openMicMode: 'Open Mic',
    micConnected: 'Microphone Connected',
    enableMic: 'Enable Microphone Audio',
    // StatsModal
    statsTitle: 'Career Telemetry & Performance',
    winRate: 'Win Rate',
    winsLosses: (w: number, l: number) => `${w}W · ${l}L`,
    kdRatio: 'K / D Ratio',
    eliminations: (n: number) => `${n} Eliminations`,
    laserAccuracy: 'Laser Accuracy',
    hitsRatio: (h: number, f: number) => `${h}/${f} Hits`,
    destructionHazards: 'Destruction & Hazards',
    hazardAssists: (n: number) => `${n} Hazard Assists`,
    emitterMastery: 'Emitter Mastery',
    totalDmg: (d: number) => `${d} Total DMG`,
    killsCount: (k: number) => `${k} Kills`,
    accShort: (a: number) => `${a}% Acc`,
    serverAuthorityTitle: 'Server Authority & Anti-Cheat',
    serverRtt: 'Server RTT',
    packetsAudited: 'Packets Audited',
    speedClamps: 'Speed Clamps',
    rateLosBlocks: 'Rate / LOS Blocks',
    recentHistory: 'Recent Match History',
    winBadge: 'WIN',
    lossBadge: 'LOSS',
    noMatchesYet: 'No recent matches yet. Deploy into an arena to record your first match!',
    // SettingsModal
    settingsTitle: 'Controller & Aim',
    settingsDesc: 'Customize interface language, input curves, deadzones, button mappings, and player profile.',
    languageSection: 'Interface Language / 界面语言',
    languageDesc: 'Switch UI, HUD alerts, and telemetry labels between Chinese and English instantly.',
    operativeProfileTitle: 'Operative Profile',
    callsignLabel: 'Callsign',
    saveBtn: 'Save',
    activePlatform: 'Active Platform',
    enableCrossplay: 'Enable Cross-Platform Matchmaking',
    mouseReticleTitle: 'Mouse & Reticle',
    mouseSensitivity: 'Mouse Sensitivity',
    fovLabel: 'Field of View (FOV)',
    crosshairStyle: 'Crosshair Style',
    crosshairPrecision: 'Precision Cross',
    crosshairChevron: 'Apex Chevron',
    crosshairRing: 'Prism Ring',
    invertLookY: 'Invert Look Y',
    controllerTuningTitle: 'Controller & Gamepad Tuning',
    padConnected: 'Pad Connected',
    noPadDetected: 'No Pad Detected',
    gamepadPolling: 'Gamepad Polling',
    hapticVibration: 'Haptic Vibration',
    stickSensitivity: 'Stick Look Sensitivity',
    leftDeadzone: 'Left Deadzone',
    rightDeadzone: 'Right Deadzone',
    actionBindings: 'Action Bindings',
    resetDefaults: 'Reset Defaults',
    // DailyMissionsModal
    missionsTitle: 'Daily Missions',
    missionsSubtitle: 'Complete daily tactical objectives to earn bonus career credits.',
    missionsResetIn: (hms: string) => `Resets in ${hms} (UTC)`,
    missionsBalanceLabel: 'Career Credits',
    missionsClaimBtn: (credits: number) => `Claim +${credits} CR`,
    missionsClaiming: 'Claiming...',
    missionsClaimed: 'Claimed',
    missionsInProgress: 'In Progress',
    missionsCompletedTag: 'Completed',
    missionsAllClearTitle: 'All-Clear Bonus',
    missionsAllClearDesc: (done: number, total: number) => `Complete all ${total} daily missions to unlock the bonus payout (${done}/${total}).`,
    missionsClaimBonusBtn: (credits: number) => `Claim Bonus +${credits} CR`,
    missionsRewardReceived: (credits: number) => `+${credits} CR Credited`,
    missionsClose: 'Close Daily Missions',
    missionsProgressSummaryTitle: 'Daily Mission Progress',
    missionsOpenBtn: 'Daily Missions',
  },
} as const;

export function formatDailyMissionCopy(
  kind: DailyMissionObjectiveKind,
  target: number,
  robotClass: RobotClass | undefined,
  lang: Language,
): { title: string; subtitle: string; category: string } {
  const unitName = robotClass ? ROBOT_CLASS_I18N[lang][robotClass].shortName : '';
  if (lang === 'zh') {
    switch (kind) {
      case 'kills_with_robot':
        return {
          title: `使用 ${unitName} 淘汰 ${target} 名对手`,
          subtitle: `在对局中驾驶 ${unitName} 完成 ${target} 次击杀（公开或自定义人机房均计入）。`,
          category: `${unitName} · 作战目标`,
        };
      case 'mine_ore_with_robot':
        return {
          title: `使用 ${unitName} 采集 ${target} 单位矿石`,
          subtitle: `部署 ${unitName} 靠近矿脉长按 [E] 采矿，为队伍累计提取 ${target} 单位矿石。`,
          category: `${unitName} · 工程支援`,
        };
      case 'win_matches':
        return {
          title: `赢得 ${target} 场对局胜利`,
          subtitle: `在任意模式中拿下 ${target} 场胜利，展现团队统治力。`,
          category: '竞技胜利',
        };
      case 'play_matches':
        return {
          title: `完成 ${target} 场完整对局`,
          subtitle: `参与并打完 ${target} 场不中途退出的完整竞技场对局。`,
          category: '出战频次',
        };
      case 'deal_damage':
        return {
          title: `累计造成 ${target} 点激光伤害`,
          subtitle: `使用任意发射器对敌方机甲造成累计 ${target} 点伤害。`,
          category: '火力输出',
        };
      case 'destroy_barriers':
        return {
          title: `摧毁 ${target} 处战术能量掩体`,
          subtitle: `集中火力击碎竞技场中的 ${target} 处可破坏能量掩体。`,
          category: '阵地破拆',
        };
    }
  }
  switch (kind) {
    case 'kills_with_robot':
      return {
        title: `Get ${target} kills with ${unitName}`,
        subtitle: `Pilot ${unitName} and score ${target} eliminations in completed matches.`,
        category: `${unitName} · Combat`,
      };
    case 'mine_ore_with_robot':
      return {
        title: `Extract ${target} ore with ${unitName}`,
        subtitle: `Deploy ${unitName} near ore veins and hold [E] to harvest ${target} ore.`,
        category: `${unitName} · Engineering`,
      };
    case 'win_matches':
      return {
        title: `Win ${target} matches`,
        subtitle: `Secure ${target} arena victories in any game mode.`,
        category: 'Victory',
      };
    case 'play_matches':
      return {
        title: `Complete ${target} matches`,
        subtitle: `Play ${target} full arena matches to completion without forfeiting.`,
        category: 'Deployment',
      };
    case 'deal_damage':
      return {
        title: `Deal ${target} laser damage`,
        subtitle: `Inflict ${target} total damage against enemy mechs with any emitter.`,
        category: 'Firepower',
      };
    case 'destroy_barriers':
      return {
        title: `Destroy ${target} tactical barriers`,
        subtitle: `Shatter ${target} destructible energy barriers across any arena.`,
        category: 'Breach',
      };
  }
}

