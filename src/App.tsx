import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
// Disable worker — Electron's file:// protocol can't load Web Workers from asset URLs
pdfjsLib.GlobalWorkerOptions.workerSrc = '';
import { io, Socket } from 'socket.io-client';
import {
  Languages,
  LogIn,
  UserPlus,
  Dice5,
  Upload,
  ChevronRight,
  ChevronLeft,
  MessageCircle,
  Users,
  LayoutGrid,
  Send,
  Plus,
  Heart,
  PawPrint,
  Search,
  Hash,
  GraduationCap,
  Briefcase,
  BookOpen,
  Smile,
  Home,
  Timer,
  Wind,
  CheckCircle2,
  Circle,
  Coffee,
  Volume2,
  VolumeX,
  Share2,
  Download,
  Image as ImageIcon,
  Trophy,
  User,
  Bell,
  Settings,
  Camera,
  Sparkles,
  Cpu,
  RefreshCw,
  CornerUpLeft,
  Paperclip,
  X,
  BarChart2,
  Bot,
  Clock,
  Zap,
  Package,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  Trash2,
  FolderOpen,
  FolderPlus,
  FileText,
  Globe,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format } from 'date-fns';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { 
  Message, 
  Post, 
  ChatGroup, 
  Pet, 
  Task, 
  StudySession, 
  TreeHolePost,
  Notification,
  UserProfile
} from './types';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ToolActivityEvent {
  id: string;
  msgId: string;
  groupId: string;
  agentId: string;
  tool: string;
  description: string;
  permission: "workspace" | "network" | "boss";
  detail?: string;
  timestamp: string;
}

const TOOL_PERMISSION_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  workspace: { label: "仅工作区", color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200", icon: "🔒" },
  network: { label: "网络请求", color: "text-blue-600", bg: "bg-blue-50 border-blue-200", icon: "🌐" },
  boss: { label: "Boss直聘操作", color: "text-amber-600", bg: "bg-amber-50 border-amber-200", icon: "🏢" },
};

const TOOL_ICON: Record<string, string> = {
  search_jobs: "🔍",
  read_applications: "📊",
  get_followups: "⏰",
  read_jobs: "📋",
  apply_job: "🚀",
  web_search: "🌐",
  read_file: "📁",
  write_file: "✏️",
};

function ToolActivityCard({ activity }: { activity: ToolActivityEvent }) {
  const perm = TOOL_PERMISSION_CONFIG[activity.permission];
  const toolIcon = TOOL_ICON[activity.tool] || "⚙️";
  return (
    <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs mx-auto w-fit max-w-[85%]", perm.bg)}>
      <span>{toolIcon}</span>
      <span className="text-pet-brown/70 font-medium">{activity.description}</span>
      {activity.detail && (
        <span className="text-pet-brown/40 font-mono truncate max-w-[120px]" title={activity.detail}>
          {activity.detail.length > 30 ? activity.detail.slice(-28) + "…" : activity.detail}
        </span>
      )}
      <span className={cn("flex items-center gap-0.5 ml-1 font-semibold shrink-0", perm.color)}>
        {perm.icon} {perm.label}
      </span>
    </div>
  );
}

const JOB_AGENTS = [
  { name: 'all',    emoji: '📣', isAll: true },
  { name: '职业规划师', emoji: '🎯', role: '背景分析、目标岗位、求职 Roadmap' },
  { name: '岗位猎手',   emoji: '🔍', role: '搜索岗位、每日扫描多平台' },
  { name: 'JD分析师',   emoji: '📋', role: '拆解岗位要求、分析匹配度' },
  { name: '简历专家',   emoji: '📝', role: '优化简历、撰写 Cover Letter' },
  { name: '投递管家',   emoji: '📊', role: '记录投递进度、设置 follow-up' },
  { name: '人脉顾问',   emoji: '🤝', role: '找联系人、起草 cold email' },
  { name: '面试教练',   emoji: '🎤', role: '模拟面试、复盘提升' },
];

const CIVIL_AGENTS = [
  { name: 'all', emoji: '📣', isAll: true },
  { name: '备考规划师', emoji: '🎯', role: '制定备考计划和时间表' },
  { name: '行测刷题师', emoji: '📝', role: '行政能力测试专项训练' },
  { name: '申论导师',   emoji: '✍️', role: '申论写作批改指导' },
  { name: '时政播报员', emoji: '📰', role: '时事政策分析解读' },
  { name: '面试教练',   emoji: '🎤', role: '结构化面试模拟训练' },
];

const GRAD_AGENTS = [
  { name: 'all', emoji: '📣', isAll: true },
  { name: '备考规划师', emoji: '🎯', role: '制定考研备考计划' },
  { name: '英语导师',   emoji: '🌍', role: '英语一/二阅读写作' },
  { name: '政治导师',   emoji: '🏛️', role: '马原毛概习概' },
  { name: '数学导师',   emoji: '📐', role: '数一/数二/数三' },
  { name: '专业课导师', emoji: '📚', role: '专业课答疑辅导' },
];

const GROUP_AGENTS: Record<string, typeof JOB_AGENTS> = {
  job: JOB_AGENTS,
  civil: CIVIL_AGENTS,
  grad: GRAD_AGENTS,
};

const GROUPS: ChatGroup[] = [
  { id: 'job', name: '求职汪成长营', icon: '🐕', description: '简历修改、面经分享、互相打气', type: 'group' },
  { id: 'civil', name: '考公喵上岸群', icon: '🐈', description: '行测申论打卡，公考资讯交流', type: 'group' },
  { id: 'grad', name: '考研兔冲刺班', icon: '🐇', description: '英语政治数学，研友互助陪伴', type: 'group' },
];

const INITIAL_CONTACTS: ChatGroup[] = [
  { id: 'c1', name: '金毛学长', icon: '🦮', description: '在吗？想请教下简历怎么改', type: 'contact' },
  { id: 'c2', name: '布偶猫学姐', icon: '🐈‍⬛', description: '今天的单词背了吗？', type: 'contact' },
];

const TRANSLATIONS = {
  zh: {
    chat: '消息',
    square: '广场',
    pet: '宠物',
    study: '自习',
    hole: '树洞',
    contacts: '联系人',
    login: '登录',
    register: '注册',
    guest: '以游客身份进入',
    email: '邮箱地址',
    password: '密码',
    onboardingTitle: '创建宠物档案',
    step: '步骤',
    petName: '给它起个名字',
    petType: '选择品种',
    petImage: '设置宠物形象',
    random: '随机摇一个',
    upload: '上传自家宠物',
    personality: '设定它的人格',
    startJourney: '开启陪伴之旅',
    next: '下一步',
    appTitle: '萌爪伴学',
    appSubtitle: '你的首席AI伴学宠物',
    loginBtn: '立即登录',
    registerBtn: '创建账号',
    or: '或者',
    cat: '猫猫',
    dog: '狗狗',
    rabbit: '兔子',
    archive: '宠物成长档案',
    joinTime: '入职时间',
    studyDuration: '伴学时长',
    problemsSolved: '解决困难',
    moodIndex: '心情指数',
    happy: '开心',
    logout: '退出登录',
    searchPlaceholder: '搜索消息或联系人...',
    pomodoro: '番茄钟',
    startStudy: '开始专注',
    stopStudy: '结束专注',
    treeHoleTitle: '情绪树洞',
    treeHoleSubtitle: '在这里放下你的压力，萌爪机器人会给你一个抱抱 🫂',
    postHole: '投递心事',
    holePlaceholder: '今天有什么不开心或者想吐槽的吗？',
    myFriends: '我的好友',
    friendsCount: '位好友',
    newPost: '发布新动态',
    selectTag: '选择板块',
    content: '内容',
    postPlaceholder: '分享你的成长点滴，或者寻找一个搭子...',
    cancel: '取消',
    publish: '发布',
  },
  en: {
    chat: 'Messages',
    square: 'Square',
    pet: 'Pet',
    study: 'Study',
    hole: 'Hole',
    contacts: 'Contacts',
    login: 'Login',
    register: 'Register',
    guest: 'Enter as Guest',
    email: 'Email Address',
    password: 'Password',
    onboardingTitle: 'Create Pet Profile',
    step: 'Step',
    petName: 'Give it a name',
    petType: 'Choose Species',
    petImage: 'Set Pet Image',
    random: 'Randomize',
    upload: 'Upload Your Pet',
    personality: 'Set Personality',
    startJourney: 'Start Journey',
    next: 'Next',
    appTitle: 'PawPals',
    appSubtitle: 'Your Chief AI Study Pet',
    loginBtn: 'Login Now',
    registerBtn: 'Create Account',
    or: 'OR',
    cat: 'Cat',
    dog: 'Dog',
    rabbit: 'Rabbit',
    archive: 'Pet Growth Archive',
    joinTime: 'Joined At',
    studyDuration: 'Study Time',
    problemsSolved: 'Solved',
    moodIndex: 'Mood',
    happy: 'Happy',
    logout: 'Logout',
    searchPlaceholder: 'Search messages or contacts...',
    pomodoro: 'Pomodoro',
    startStudy: 'Start Focus',
    stopStudy: 'Stop Focus',
    treeHoleTitle: 'Tree Hole',
    treeHoleSubtitle: 'Leave your stress here, PawPals bot will give you a hug 🫂',
    postHole: 'Post Secret',
    holePlaceholder: 'Anything bothering you today?',
    myFriends: 'My Friends',
    friendsCount: 'Friends',
    newPost: 'New Post',
    selectTag: 'Select Tag',
    content: 'Content',
    postPlaceholder: 'Share your growth or find a partner...',
    cancel: 'Cancel',
    publish: 'Publish',
  }
};

type SetupProviderState = {
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelCount: number;
};

type SetupResponse = {
  completed: boolean;
  selectedProvider: string;
  selectedModel: string;
  primaryModel: string;
  providers: Record<string, SetupProviderState>;
  recommendedModels: {
    provider: string;
    model: string;
    providerName: string;
    displayName: string;
    blurb: string;
    keyUrl: string;
  }[];
  completedAt: string | null;
};

type RuntimeStatus = {
  ok: boolean;
  mode: 'isolated' | 'shared';
  appDataDir: string;
  openClawHome: string;
  workspaceRoot: string;
  gatewayBaseUrl: string;
  gatewayReachable: boolean;
  webChannelReady: boolean;
  chiefSessionKey: string;
};

type DeploymentStatus = {
  ok: boolean;
  status: 'idle' | 'running' | 'ready' | 'error';
  phase: string;
  deployed: boolean;
  deployedAt: string | null;
  updatedAt: string | null;
  gatewayBaseUrl: string;
  appUrl: string | null;
  appPort: string | null;
  openClawHome: string;
  appDataDir: string;
  usingBundledRuntime: boolean;
  usingBundledNode: boolean;
  usingBundledOpenClaw: boolean;
  error: string | null;
  logs: string[];
};

type ModelCard = {
  provider: string;
  model: string;
  title: string;
  subtitle: string;
  description: string;
  keyUrl: string;
  keyLabel: string;
  badge: string;
  emoji: string;
  placeholder: string;
  custom?: boolean;
};

type ModelCompany = {
  provider: string;
  company: string;
  subtitle: string;
  description: string;
  keyUrl: string;
  keyLabel: string;
  badge: string;
  emoji: string;
  placeholder: string;
  models: Array<{
    model: string;
    label: string;
    note: string;
  }>;
  custom?: boolean;
};

const MODEL_COMPANIES: readonly ModelCompany[] = [
  {
    provider: 'anthropic',
    company: 'Claude',
    subtitle: 'Anthropic 官方 API',
    description: '写作、长对话和高质量表达都很稳，适合求职主流程。',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyLabel: '去拿 Anthropic Key',
    badge: '推荐首选',
    emoji: '🧠',
    placeholder: '粘贴你的 Anthropic API Key',
    models: [
      { model: 'claude-opus-4-6', label: 'Claude Opus 4.6', note: '效果优先，适合重度使用' },
      { model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: '速度和质量更均衡' },
    ],
  },
  {
    provider: 'gemini',
    company: 'Google Gemini',
    subtitle: 'Google AI Studio / Gemini API',
    description: '上手快，速度轻快，适合日常问答和多轮互动。',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyLabel: '去拿 Gemini Key',
    badge: '速度很快',
    emoji: '⚡',
    placeholder: '粘贴你的 Gemini API Key',
    models: [
      { model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', note: '推荐多数用户先用它' },
      { model: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview', note: '更适合复杂推理和长任务' },
    ],
  },
  {
    provider: 'openai',
    company: 'OpenAI',
    subtitle: 'OpenAI 官方 API',
    description: '通用性强，适合写作、工具调用和稳定助理能力。',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyLabel: '去拿 OpenAI Key',
    badge: '国际主流',
    emoji: '🌐',
    placeholder: '粘贴你的 OpenAI API Key',
    models: [
      { model: 'gpt-5-mini', label: 'GPT-5 mini', note: '更轻快，适合大部分使用' },
      { model: 'gpt-5', label: 'GPT-5', note: '效果更强，适合复杂任务' },
    ],
  },
  {
    provider: 'zai',
    company: '智谱 GLM',
    subtitle: '智谱官方 API',
    description: '中文体验稳定，适合岗位分析、简历和复盘。',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    keyLabel: '去拿 GLM Key',
    badge: '中文友好',
    emoji: '🪄',
    placeholder: '粘贴你的 GLM API Key',
    models: [
      { model: 'glm-5', label: 'GLM-5', note: '当前主推，适合中文主流程' },
      { model: 'glm-4.7', label: 'GLM-4.7', note: '偏稳妥的通用选择' },
      { model: 'glm-4.7-flash', label: 'GLM-4.7 Flash', note: '更快更轻量' },
    ],
  },
  {
    provider: 'minimax',
    company: 'MiniMax',
    subtitle: 'MiniMax 官方接口',
    description: '国内热门，适合中文和 Agent 任务。',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    keyLabel: '去拿 MiniMax Key',
    badge: '国内热门',
    emoji: '🌊',
    placeholder: '粘贴你的 MiniMax API Key',
    models: [
      { model: 'MiniMax-M2.5', label: 'MiniMax M2.5', note: '当前推荐模型' },
    ],
  },
  {
    provider: 'volcengine',
    company: '火山引擎 Doubao',
    subtitle: '字节系官方模型入口',
    description: '如果你更偏国内链路，这里可以直接接火山引擎的模型。',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    keyLabel: '去拿火山引擎 Key',
    badge: '国内热门',
    emoji: '🔥',
    placeholder: '粘贴你的火山引擎 API Key',
    models: [
      { model: 'doubao-seed-1-6-251015', label: 'Doubao Seed 1.6', note: '当前推荐入口' },
    ],
  },
  {
    provider: 'custom',
    company: '自己接一个模型',
    subtitle: '高级设置 / OpenAI 兼容接口',
    description: '如果你有自己的模型网关、代理服务或公司内部 API，再从这里手动填。',
    keyUrl: '',
    keyLabel: '',
    badge: '高级设置',
    emoji: '🧩',
    placeholder: '粘贴你的 API Key',
    models: [
      { model: '', label: '手动填写模型名', note: '适合高级用户' },
    ],
    custom: true,
  },
];

const SETUP_STEPS = [
  { id: 1, label: '部署引擎' },
  { id: 2, label: '选公司' },
  { id: 3, label: '接入 Key' },
  { id: 4, label: '开始使用' },
] as const;

export default function App() {
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const t = (key: keyof typeof TRANSLATIONS['zh']) => TRANSLATIONS[lang][key] || key;

  const [appStatus, setAppStatus] = useState<'landing' | 'auth' | 'onboarding' | 'main'>('auth');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [petProfileConfigured, setPetProfileConfigured] = useState(!!localStorage.getItem('petProfileConfigured'));
  const [showPetProfileWizard, setShowPetProfileWizard] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'dashboard' | 'pet' | 'study' | 'hole' | 'contacts' | 'manage' | 'square'>('pet');
  const localizedGroups = GROUPS.map(g => ({
    ...g,
    name: lang === 'zh' ? g.name : (g.id === 'job' ? 'Job Seekers' : g.id === 'civil' ? 'Civil Exam' : 'Grad Exam'),
    description: lang === 'zh' ? g.description : (g.id === 'job' ? 'Resume review, interview sharing' : g.id === 'civil' ? 'Daily check-in, exam info' : 'English, Math, study buddies')
  }));

  const localizedContacts = INITIAL_CONTACTS.map(c => ({
    ...c,
    name: lang === 'zh' ? c.name : (c.id === 'c1' ? 'Golden Senior' : 'Ragdoll Senior'),
    description: lang === 'zh' ? c.description : (c.id === 'c1' ? 'Are you there? Need resume help' : 'Did you memorize words today?')
  }));

  const [activeChat, setActiveChat] = useState<ChatGroup | null>(localizedGroups[0]);
  const [showChatDetail, setShowChatDetail] = useState(false);
  const [showMemberPanel, setShowMemberPanel] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [treeHolePosts, setTreeHolePosts] = useState<TreeHolePost[]>([]);
  const [studyRoomUsers, setStudyRoomUsers] = useState<StudySession[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; sender: string; content: string } | null>(null);
  const [attachedFile, setAttachedFile] = useState<{ name: string; content: string } | null>(null);
  const [attachedImage, setAttachedImage] = useState<{ name: string; dataUrl: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mentionPicker, setMentionPicker] = useState<{ visible: boolean; query: string; idx: number }>({ visible: false, query: '', idx: 0 });
  const [bossLoginStatus, setBossLoginStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [showPlatformDialog, setShowPlatformDialog] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const platformsConfigured = useRef(!!localStorage.getItem('platformsConfigured'));
  const [postContent, setPostContent] = useState('');
  const [postTag, setPostTag] = useState<Post['tag']>('生活');
  const [showPostModal, setShowPostModal] = useState(false);
  const [holeContent, setHoleContent] = useState('');
  const [showStudyCompleteModal, setShowStudyCompleteModal] = useState(false);
  const [lastStudyDuration, setLastStudyDuration] = useState(25);
  const [botNotification, setBotNotification] = useState<{ botName: string, friendName: string, message: string } | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([
    { id: '1', type: 'achievement', title: '达成成就', content: '恭喜！你已累计自习超过 100 分钟！', timestamp: new Date().toISOString(), read: false },
    { id: '2', type: 'system', title: '首席官上线', content: '你的首席伴学官已就位，快去设置它的人格吧！', timestamp: new Date().toISOString(), read: true },
  ]);
  const [showPetSettings, setShowPetSettings] = useState(false);
  const [showUserSettings, setShowUserSettings] = useState(false);
  const [showModelSwitch, setShowModelSwitch] = useState(false);
  const [switchProvider, setSwitchProvider] = useState('');
  const [switchModel, setSwitchModel] = useState('');
  const [switchApiKey, setSwitchApiKey] = useState('');
  const [switchBaseUrl, setSwitchBaseUrl] = useState('');
  const [switchCustomProvider, setSwitchCustomProvider] = useState('custom-openai');
  const [switchCustomModel, setSwitchCustomModel] = useState('');
  const [switchLoading, setSwitchLoading] = useState(false);
  const [switchMessage, setSwitchMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showNotificationsPopover, setShowNotificationsPopover] = useState(false);
  const [showUserPopover, setShowUserPopover] = useState(false);
  const [setupState, setSetupState] = useState<SetupResponse | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<DeploymentStatus | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // Dashboard data
  const [dashAgents, setDashAgents] = useState<any[]>([]);
  const [dashUsage, setDashUsage] = useState<any[]>([]);
  const [dashCron, setDashCron] = useState<any[]>([]);
  const [dashSkills, setDashSkills] = useState<any[]>([]);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError] = useState<string | null>(null);
  const [cronNewName, setCronNewName] = useState('');
  const [cronNewMsg, setCronNewMsg] = useState('');
  const [cronNewSchedule, setCronNewSchedule] = useState('0 9 * * *');
  const [cronAdding, setCronAdding] = useState(false);
  const [showAddCron, setShowAddCron] = useState(false);
  const [skillSearch, setSkillSearch] = useState('');
  const [skillSearchResults, setSkillSearchResults] = useState<any[]>([]);
  const [skillSearching, setSkillSearching] = useState(false);
  const [backupStatus, setBackupStatus] = useState<any>(null);
  const [backingUp, setBackingUp] = useState(false);

  // Manage panel state
  const [managePaths, setManagePaths] = useState<string[]>([]);
  const [manageNewPath, setManageNewPath] = useState('');
  const [manageFiles, setManageFiles] = useState<{name:string;path:string;size:number;mtime:string}[]>([]);
  const [manageFilesLoading, setManageFilesLoading] = useState(false);
  const [managePathsLoading, setManagePathsLoading] = useState(false);
  const [manageUploadStatus, setManageUploadStatus] = useState<string | null>(null);
  const manageUploadRef = useRef<HTMLInputElement>(null);
  const [restoringSnapshot, setRestoringSnapshot] = useState<string | null>(null);
  const [sanitizing, setSanitizing] = useState(false);
  const [sanitizeResult, setSanitizeResult] = useState<string | null>(null);
  const [connTesting, setConnTesting] = useState(false);
  const [connResults, setConnResults] = useState<{provider:string;status:'ok'|'fail'|'skip';reason?:string;model?:string;elapsed?:number}[]|null>(null);
  const [setupStep, setSetupStep] = useState(1);
  const [selectedCompanyProvider, setSelectedCompanyProvider] = useState(MODEL_COMPANIES[0].provider);
  const [selectedSetupModel, setSelectedSetupModel] = useState(MODEL_COMPANIES[0].models[0].model);
  const [setupApiKey, setSetupApiKey] = useState('');
  const [customProviderKey, setCustomProviderKey] = useState('custom-openai');
  const [customModelName, setCustomModelName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupMessage, setSetupMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [setupValidating, setSetupValidating] = useState(false);
  const [bootLogs, setBootLogs] = useState<string[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [toolActivities, setToolActivities] = useState<ToolActivityEvent[]>([]);

  // User State
  const [userProfile, setUserProfile] = useState<UserProfile>({
    name: '萌爪用户',
    avatar: 'https://api.dicebear.com/7.x/adventurer/svg?seed=Me',
    signature: '正在努力学习中，今天也要加油呀！',
    email: 'bingyue09@gmail.com'
  });

  // Pet State
  const [pet, setPet] = useState<Pet>({ 
    level: 1, 
    energy: 50, 
    name: '团团', 
    type: 'cat', 
    exp: 0,
    personality: '温柔体贴，偶尔有点小调皮，最喜欢看你认真学习的样子。',
    avatar: 'https://api.dicebear.com/7.x/adventurer/svg?seed=ChiefDog'
  });
  const [tasks, setTasks] = useState<Task[]>([
    { id: 't1', title: '背诵 50 个考研单词', completed: false, energyReward: 20 },
    { id: 't2', title: '完成一套行测模拟题', completed: false, energyReward: 30 },
    { id: 't3', title: '修改简历个人总结', completed: false, energyReward: 15 },
  ]);

  // Pomodoro State
  const [timeLeft, setTimeLeft] = useState(25 * 60);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  
  const socketRef = useRef<Socket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const chiefWakeRequestedRef = useRef(false);
  const onboardingAfterWakeRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const buildChiefChat = (): ChatGroup => ({
    id: 'pixel',
    name: pet.name,
    icon: pet.type === 'cat' ? '🐈' : pet.type === 'dog' ? '🐕' : '🐇',
    description: '你的专属伴学官',
    type: 'contact',
  });

  const requestChiefWake = () => {
    const hasPixelHistory = messagesRef.current.some((message) => message.groupId === 'pixel');
    if (hasPixelHistory || chiefWakeRequestedRef.current) return;
    chiefWakeRequestedRef.current = true;
    socketRef.current?.emit('wake_chief_session', {
      petName: pet.name,
    });
  };

  useEffect(() => {
    socketRef.current = io();

    socketRef.current.on('init_messages', (msgs: Message[]) => {
      messagesRef.current = msgs;
      if (msgs.some((msg) => msg.groupId === 'pixel')) {
        chiefWakeRequestedRef.current = true;
      }
      setMessages(msgs);
    });
    socketRef.current.on('init_posts', (ps: Post[]) => setPosts(ps));
    socketRef.current.on('init_tree_hole', (ps: TreeHolePost[]) => setTreeHolePosts(ps));
    socketRef.current.on('init_study_room', (users: StudySession[]) => setStudyRoomUsers(users));
    socketRef.current.on('update_study_room', (users: StudySession[]) => setStudyRoomUsers(users));
    socketRef.current.on('update_tree_hole', (ps: TreeHolePost[]) => setTreeHolePosts(ps));
    socketRef.current.on('new_tree_hole', (post: TreeHolePost) => setTreeHolePosts(prev => [post, ...prev]));

    socketRef.current.on('receive_message', (msg: Message) => {
      messagesRef.current = [...messagesRef.current, msg];
      setMessages(prev => [...prev, msg]);
    });
    socketRef.current.on('remove_message', (id: string) => {
      setMessages(prev => prev.filter(m => m.id !== id));
    });
    socketRef.current.on('stream_chunk', ({ id, token }: { id: string; token: string }) => {
      setMessages(prev => prev.map(m =>
        m.id === id ? { ...m, content: m.content + token, isLoading: false } : m
      ));
    });
    socketRef.current.on('tool_activity', (activity: ToolActivityEvent) => {
      setToolActivities(prev => [...prev, activity]);
      // Auto-clear after 30s so it doesn't pile up
      setTimeout(() => {
        setToolActivities(prev => prev.filter(a => a.id !== activity.id));
      }, 30000);
    });
    socketRef.current.on('stream_done', ({ id }: { id: string }) => {
      setMessages(prev => prev.map(m =>
        m.id === id ? { ...m, isLoading: false } : m
      ));
      const doneMessage = messagesRef.current.find((message) => message.id === id);
      if (doneMessage?.groupId === 'pixel' && onboardingAfterWakeRef.current && !petProfileConfigured) {
        onboardingAfterWakeRef.current = false;
        window.setTimeout(() => {
          setOnboardingStep(1);
          setShowPetProfileWizard(true);
        }, 280);
      }
    });
    socketRef.current.on('boss_login_result', ({ ok }: { ok: boolean }) => {
      setBossLoginStatus(ok ? 'ok' : 'error');
      setTimeout(() => setBossLoginStatus('idle'), 5000);
    });
    socketRef.current.on('new_post', (post: Post) => {
      setPosts(prev => [post, ...prev]);
    });
    socketRef.current.on('bot_friendship', (data: any) => {
      setBotNotification(data);
      const newNotif: Notification = {
        id: Date.now().toString(),
        type: 'friendship',
        title: 'Bot 社交动态',
        content: data.message,
        timestamp: new Date().toISOString(),
        read: false
      };
      setNotifications(prev => [newNotif, ...prev]);
      setTimeout(() => setBotNotification(null), 5000);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const selectedCompany = MODEL_COMPANIES.find(
    (company) => company.provider === selectedCompanyProvider,
  ) || MODEL_COMPANIES[0];
  const selectedProviderState = setupState?.providers?.[selectedCompany.provider];
  const hasSavedKeyForSelectedProvider = Boolean(selectedProviderState?.apiKeyConfigured);
  const resolvedSetupProvider = selectedCompany.custom ? customProviderKey.trim() : selectedCompany.provider;
  const resolvedSetupModel = selectedCompany.custom ? customModelName.trim() : selectedSetupModel.trim();
  const resolvedSetupBaseUrl = selectedCompany.custom ? customBaseUrl.trim() : '';

  const loadSetupState = async (options?: { forceOpen?: boolean }) => {
    try {
      const response = await fetch('/api/setup');
      const data: SetupResponse = await response.json();
      setSetupState(data);

      if (data.primaryModel) {
        const [provider, model] = data.primaryModel.split('/');
        if (provider) setSelectedCompanyProvider(provider);
        if (model) setSelectedSetupModel(model);
      }

      if (options?.forceOpen) {
        setShowSetupWizard(true);
        setSetupStep(data.completed ? 4 : 1);
        setSetupApiKey('');
        setSetupMessage(null);
        return;
      }

      if (!data.completed) {
        setShowSetupWizard(true);
        setSetupStep(1);
      }
    } catch {
      setSetupState(null);
    }
  };

  const loadDeploymentStatus = async () => {
    const response = await fetch('/api/deployment/status');
    const data: DeploymentStatus = await response.json();
    setDeploymentStatus(data);
  };

  const loadRuntimeStatus = async () => {
    const response = await fetch('/api/runtime/status');
    const data: RuntimeStatus = await response.json();
    setRuntimeStatus(data);
    setBootLogs([
      `$ pawpals bootstrap --channel web-ui`,
      `[runtime] mode=${data.mode} chief_session=${data.chiefSessionKey}`,
      `[gateway] ${data.gatewayReachable ? 'online' : 'offline'} @ ${data.gatewayBaseUrl}`,
      `[openclaw] home=${data.openClawHome}`,
      `[workspace] ${data.workspaceRoot}`,
      `[channel] pawpals-web-ui ${data.webChannelReady ? 'ready' : 'waiting'}`,
    ]);
  };

  useEffect(() => {
    if (appStatus !== 'main') return;
    loadDeploymentStatus();
    loadSetupState();
  }, [appStatus]);

  useEffect(() => {
    if (!showSetupWizard || appStatus !== 'main') return;

    loadDeploymentStatus();
    const timer = window.setInterval(() => {
      loadDeploymentStatus().catch(() => {});
    }, 2000);

    return () => window.clearInterval(timer);
  }, [showSetupWizard, appStatus]);

  useEffect(() => {
    if (isTimerRunning && timeLeft > 0) {
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => prev - 1);
      }, 1000);
    } else if (timeLeft === 0) {
      handleTimerComplete();
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isTimerRunning, timeLeft]);

  const handleTimerComplete = () => {
    setIsTimerRunning(false);
    setTimeLeft(25 * 60);
    setLastStudyDuration(25);
    setShowStudyCompleteModal(true);
    
    const expGain = 20;
    setPet(prev => {
      const newExp = prev.exp + expGain;
      const levelUp = newExp >= prev.level * 100;
      return { 
        ...prev, 
        exp: levelUp ? 0 : newExp, 
        level: levelUp ? prev.level + 1 : prev.level,
        energy: Math.min(100, prev.energy + 10)
      };
    });
    socketRef.current?.emit('leave_study_room');
  };

  const handleShareStudyPoster = () => {
    const content = `我刚刚和我的宠物 ${pet.name} 一起完成了 ${lastStudyDuration} 分钟的深度自习！✨ 宠物也升级到 Lv.${pet.level} 啦，快来和我一起伴学吧！🐾 #自习打卡 #萌宠伴学`;
    socketRef.current?.emit('create_post', {
      content,
      tag: '生活',
      author: userProfile.name,
      avatar: userProfile.avatar
    });
    setShowStudyCompleteModal(false);
    setActiveTab('pet');
  };

  const toggleTimer = () => {
    if (!isTimerRunning) {
      socketRef.current?.emit('join_study_room', { 
        userId: 'me', 
        userName: userProfile.name, 
        avatar: userProfile.avatar,
        petIcon: pet.type === 'cat' ? '🐈' : pet.type === 'dog' ? '🐕' : '🐇'
      });
    } else {
      socketRef.current?.emit('leave_study_room');
    }
    setIsTimerRunning(!isTimerRunning);
  };

  const handleToggleTask = (id: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id === id && !t.completed) {
        setPet(p => ({ ...p, energy: Math.min(100, p.energy + t.energyReward), exp: p.exp + 5 }));
        return { ...t, completed: true };
      }
      return t;
    }));
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeChat]);

  // Load dashboard data when switching to dashboard tab
  useEffect(() => {
    if (activeTab !== 'dashboard') return;
    let cancelled = false;
    const loadDash = async () => {
      setDashLoading(true);
      setDashError(null);
      try {
        const [agentsRes, usageRes, cronRes, skillsRes, backupRes] = await Promise.allSettled([
          fetch('/api/gw/agents').then(r => r.json()),
          fetch('/api/gw/usage/recent-token-history').then(r => r.json()),
          fetch('/api/gw/cron/jobs').then(r => r.json()),
          fetch('/api/gw/clawhub/list').then(r => r.json()),
          fetch('/api/backup/status').then(r => r.json()),
        ]);
        if (cancelled) return;
        if (agentsRes.status === 'fulfilled') setDashAgents(agentsRes.value?.agents || []);
        if (usageRes.status === 'fulfilled') setDashUsage(Array.isArray(usageRes.value) ? usageRes.value : []);
        if (cronRes.status === 'fulfilled') setDashCron(Array.isArray(cronRes.value) ? cronRes.value : []);
        if (skillsRes.status === 'fulfilled') setDashSkills(skillsRes.value?.results || []);
        if (backupRes.status === 'fulfilled') setBackupStatus(backupRes.value);
      } catch {
        if (!cancelled) setDashError('无法获取数据，请确认 AI 服务已启动');
      } finally {
        if (!cancelled) setDashLoading(false);
      }
    };
    void loadDash();
    return () => { cancelled = true; };
  }, [activeTab]);

  const dashTotalTokens = dashUsage.reduce((sum: number, e: any) => sum + (e.totalTokens || 0), 0);
  const dashTotalCost = dashUsage.reduce((sum: number, e: any) => sum + (e.costUsd || 0), 0);

  // Load manage panel data
  useEffect(() => {
    if (activeTab !== 'manage') return;
    loadManagePaths();
    loadManageFiles();
  }, [activeTab]);

  const loadManagePaths = async () => {
    setManagePathsLoading(true);
    try {
      const r = await fetch('/api/manage/paths').then(r => r.json());
      setManagePaths(r.paths || []);
    } catch {}
    setManagePathsLoading(false);
  };

  const loadManageFiles = async () => {
    setManageFilesLoading(true);
    try {
      const r = await fetch('/api/manage/files').then(r => r.json());
      setManageFiles(r.files || []);
    } catch {}
    setManageFilesLoading(false);
  };

  const handleAddManagePath = async () => {
    const p = manageNewPath.trim();
    if (!p) return;
    await fetch('/api/manage/paths', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    setManageNewPath('');
    loadManagePaths();
  };

  const handleRemoveManagePath = async (p: string) => {
    await fetch('/api/manage/paths', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    loadManagePaths();
  };

  const handleManageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setManageUploadStatus('上传中…');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const r = await fetch('/api/manage/upload', { method: 'POST', body: formData }).then(r => r.json());
      setManageUploadStatus(r.ok ? `✓ 已上传：${r.filename}` : `✗ ${r.error}`);
      if (r.ok) loadManageFiles();
    } catch {
      setManageUploadStatus('✗ 上传失败');
    }
    if (manageUploadRef.current) manageUploadRef.current.value = '';
    setTimeout(() => setManageUploadStatus(null), 4000);
  };

  const handleCronToggle = async (id: string, enabled: boolean) => {
    await fetch('/api/gw/cron/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled }) });
    setDashCron(prev => prev.map((j: any) => j.id === id ? { ...j, enabled } : j));
  };

  const handleCronDelete = async (id: string) => {
    await fetch(`/api/gw/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setDashCron(prev => prev.filter((j: any) => j.id !== id));
  };

  const handleCronAdd = async () => {
    if (!cronNewName.trim() || !cronNewMsg.trim()) return;
    setCronAdding(true);
    try {
      await fetch('/api/gw/cron/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cronNewName, message: cronNewMsg, schedule: cronNewSchedule, enabled: true }) });
      const res = await fetch('/api/gw/cron/jobs').then(r => r.json());
      setDashCron(Array.isArray(res) ? res : []);
      setCronNewName(''); setCronNewMsg(''); setShowAddCron(false);
    } finally {
      setCronAdding(false);
    }
  };

  const handleSkillSearch = async () => {
    if (!skillSearch.trim()) return;
    setSkillSearching(true);
    try {
      const res = await fetch('/api/gw/clawhub/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: skillSearch, limit: 10 }) }).then(r => r.json());
      setSkillSearchResults(res?.results || []);
    } finally {
      setSkillSearching(false);
    }
  };

  const handleSkillInstall = async (slug: string) => {
    await fetch('/api/gw/clawhub/install', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }) });
    const res = await fetch('/api/gw/clawhub/list').then(r => r.json());
    setDashSkills(res?.results || []);
    setSkillSearchResults([]);
    setSkillSearch('');
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!inputValue.trim() && !attachedFile && !attachedImage) || !activeChat) return;

    const content = replyTo
      ? `> 回复 **${replyTo.sender}**：${replyTo.content.replace(/\n/g, ' ').slice(0, 60)}${replyTo.content.length > 60 ? '…' : ''}\n\n${inputValue || (attachedImage ? '请看图片' : '请看附件')}`
      : (inputValue || (attachedImage ? '请看图片' : '请看附件'));

    const msg = {
      sender: userProfile.name,
      avatar: userProfile.avatar,
      content,
      groupId: activeChat.id,
      petName: pet.name,
      petPersonality: pet.personality,
    };

    const finalContent = attachedFile
      ? `[附件：${attachedFile.name}]\n\n${attachedFile.content}\n\n---\n\n${content}`
      : content;

    socketRef.current?.emit('send_message', {
      ...msg,
      content: finalContent,
      ...(attachedImage ? { imageData: attachedImage.dataUrl, imageName: attachedImage.name } : {}),
    });
    setInputValue('');
    setReplyTo(null);
    setAttachedFile(null);
    setAttachedImage(null);
  };

  const handleFileAttach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAttachedImage({ name: file.name, dataUrl: String(ev.target?.result || '') });
        setAttachedFile(null);
      };
      reader.readAsDataURL(file);
    } else if (file.name.toLowerCase().endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        setAttachedFile({ name: file.name, content: `[Word文档: ${file.name}]\n\n${result.value}` });
        setAttachedImage(null);
      } catch (err) {
        console.error('Word parse error:', err);
        setAttachedFile({ name: file.name, content: `[Word文档: ${file.name}，解析失败，请粘贴文字内容]` });
        setAttachedImage(null);
      }
    } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true } as any).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map((item: any) => item.str).join(' '));
        }
        const text = pages.join('\n\n');
        setAttachedFile({ name: file.name, content: `[PDF: ${file.name}]\n\n${text}` });
        setAttachedImage(null);
      } catch (err) {
        console.error('PDF parse error:', err);
        setAttachedFile({ name: file.name, content: `[PDF 文件: ${file.name}，解析失败，请粘贴文字内容]` });
        setAttachedImage(null);
      }
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAttachedFile({ name: file.name, content: String(ev.target?.result || '') });
        setAttachedImage(null);
      };
      reader.readAsText(file);
    }
  };

  const handleCreatePost = () => {
    if (!postContent.trim()) return;

    const post = {
      author: userProfile.name,
      avatar: userProfile.avatar,
      content: postContent,
      tag: postTag,
    };

    socketRef.current?.emit('create_post', post);
    setPostContent('');
    setShowPostModal(false);
  };

  const handleDroppedFile = async (file: File) => {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAttachedImage({ name: file.name, dataUrl: String(ev.target?.result || '') });
        setAttachedFile(null);
      };
      reader.readAsDataURL(file);
    } else if (file.name.toLowerCase().endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        setAttachedFile({ name: file.name, content: `[Word文档: ${file.name}]\n\n${result.value}` });
        setAttachedImage(null);
      } catch {
        setAttachedFile({ name: file.name, content: `[Word文档: ${file.name}，解析失败，请粘贴文字内容]` });
        setAttachedImage(null);
      }
    } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true } as any).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pages.push(content.items.map((item: any) => item.str).join(' '));
        }
        setAttachedFile({ name: file.name, content: `[PDF: ${file.name}]\n\n${pages.join('\n\n')}` });
        setAttachedImage(null);
      } catch {
        setAttachedFile({ name: file.name, content: `[PDF 文件: ${file.name}，解析失败，请粘贴文字内容]` });
        setAttachedImage(null);
      }
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAttachedFile({ name: file.name, content: String(ev.target?.result || '') });
        setAttachedImage(null);
      };
      reader.readAsText(file);
    }
  };

  const filteredMessages = messages.filter(m => m.groupId === activeChat?.id);
  const filteredActivities = toolActivities.filter(a => a.groupId === activeChat?.id);

  const handleSelectChat = (chat: ChatGroup) => {
    setActiveChat(chat);
    setShowChatDetail(true);
    setShowMemberPanel(false);
    if (chat.id === 'job' && !platformsConfigured.current) {
      setShowPlatformDialog(true);
    }
    if (chat.id === 'pixel') {
      requestChiefWake();
    }
  };

  const handlePlatformConfirm = async () => {
    platformsConfigured.current = true;
    localStorage.setItem('platformsConfigured', '1');
    setShowPlatformDialog(false);
    if (selectedPlatforms.includes('boss')) {
      setBossLoginStatus('loading');
      fetch('/api/boss-login', { method: 'POST' }).catch(() => {});
    }
  };

  const openSetupWizard = async () => {
    setSetupMessage(null);
    setSetupApiKey('');
    await loadDeploymentStatus();
    await loadSetupState({ forceOpen: true });
  };

  const handleValidateSetupKey = async () => {
    if (!setupApiKey.trim()) {
      setSetupMessage({ type: 'error', text: '先把 API Key 粘贴进来，我再帮你试连。' });
      return;
    }
    if (!resolvedSetupProvider || !resolvedSetupModel) {
      setSetupMessage({ type: 'error', text: '先把 provider 和模型名填完整。' });
      return;
    }
    if (selectedCompany.custom && !resolvedSetupBaseUrl) {
      setSetupMessage({ type: 'error', text: '自定义模型还需要填写 base URL。' });
      return;
    }

    setSetupValidating(true);
    setSetupMessage({ type: 'info', text: '正在试连模型服务，通常十秒内会有结果。' });

    try {
      const response = await fetch('/api/setup/model/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: resolvedSetupProvider,
          model: resolvedSetupModel,
          apiKey: setupApiKey.trim(),
          baseUrl: resolvedSetupBaseUrl,
        }),
      });
      const data = await response.json();
      setSetupMessage({
        type: data.ok ? 'success' : 'error',
        text: data.message || (data.ok ? '连接正常，可以保存。' : '暂时没连通，请稍后重试。'),
      });
    } catch {
      setSetupMessage({ type: 'error', text: '网络出了点波动，稍后再试一次。' });
    } finally {
      setSetupValidating(false);
    }
  };

  const handleSaveSetup = async () => {
    if (!setupApiKey.trim() && !hasSavedKeyForSelectedProvider) {
      setSetupMessage({ type: 'error', text: '这一步还差一个 API Key，填上后我才能帮你保存。' });
      return;
    }
    if (!resolvedSetupProvider || !resolvedSetupModel) {
      setSetupMessage({ type: 'error', text: '先把 provider 和模型名填完整。' });
      return;
    }
    if (selectedCompany.custom && !resolvedSetupBaseUrl) {
      setSetupMessage({ type: 'error', text: '自定义模型还需要填写 base URL。' });
      return;
    }

    setSetupLoading(true);
    setSetupMessage({ type: 'info', text: '正在把默认模型写进萌爪伴学自己的运行环境。' });

    try {
      const response = await fetch('/api/setup/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: resolvedSetupProvider,
          model: resolvedSetupModel,
          apiKey: setupApiKey.trim(),
          baseUrl: resolvedSetupBaseUrl,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || '保存失败');
      }

      setSetupState(data.setup);
      await loadRuntimeStatus();
      setSetupStep(4);
      setSetupMessage({ type: 'success', text: '默认模型已经配好，下面是这套独立 OpenClaw 的实时状态。' });
      setSetupApiKey('');
    } catch (error: any) {
      setSetupMessage({ type: 'error', text: error.message || '保存失败，请稍后重试。' });
    } finally {
      setSetupLoading(false);
    }
  };

  const handleRandomizePet = () => {
    const types: Pet['type'][] = ['cat', 'dog', 'rabbit'];
    const randomType = types[Math.floor(Math.random() * types.length)];
    const randomSeed = Math.random().toString(36).substring(7);
    const avatar = `https://api.dicebear.com/7.x/adventurer/svg?seed=${randomSeed}`;
    setPet(prev => ({ ...prev, type: randomType, avatar }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPet(prev => ({ ...prev, avatar: reader.result as string }));
      };
      reader.readAsDataURL(file);
    }
  };

  const handleFinishPetProfile = () => {
    localStorage.setItem('petProfileConfigured', '1');
    setPetProfileConfigured(true);
    setShowPetProfileWizard(false);
    setAppStatus('main');
  };

  const renderPetProfileCard = () => (
    <motion.div 
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      className="w-full max-w-2xl bg-white rounded-[40px] overflow-hidden pet-shadow flex flex-col md:flex-row"
    >
      <div className="w-full md:w-1/2 bg-pet-orange/5 p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-pet-orange/10">
        <motion.div 
          key={pet.avatar}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative"
        >
          <div className="w-48 h-48 md:w-64 md:h-64 bg-white rounded-[40px] pet-shadow p-4 flex items-center justify-center overflow-hidden">
            <img 
              src={pet.avatar} 
              alt="Pet Preview" 
              className="w-full h-full object-cover rounded-[32px]"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 bg-pet-orange text-white px-6 py-2 rounded-full font-bold pet-shadow">
            {pet.name || '未命名'}
          </div>
        </motion.div>
        <p className="mt-12 text-sm text-pet-brown/40 italic">“{pet.personality}”</p>
      </div>

      <div className="w-full md:w-1/2 p-8 md:p-12 space-y-8 relative">
        <div className="absolute top-4 right-4">
          <button 
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            className="p-2 text-pet-brown/40 hover:text-pet-orange transition-colors"
          >
            <Languages size={18} />
          </button>
        </div>

        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-2xl font-display font-bold text-pet-brown">{t('onboardingTitle')}</h2>
            <p className="text-pet-brown/40 text-xs mt-1">{t('step')} {onboardingStep} / 3</p>
          </div>
          <div className="flex gap-1">
            {[1, 2, 3].map(s => (
              <div key={s} className={cn("w-2 h-2 rounded-full", s <= onboardingStep ? "bg-pet-orange" : "bg-pet-cream")} />
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait">
          {onboardingStep === 1 && (
            <motion.div 
              key="step1"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div>
                <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">{t('petName')}</label>
                <input 
                  type="text" 
                  value={pet.name}
                  onChange={(e) => setPet(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-pet-brown font-bold"
                  placeholder="例如：团团、芝麻..."
                />
              </div>
              <div>
                <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">{t('petType')}</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { type: 'cat', icon: '🐈', label: t('cat') },
                    { type: 'dog', icon: '🐕', label: t('dog') },
                    { type: 'rabbit', icon: '🐇', label: t('rabbit') },
                  ].map(item => (
                    <button 
                      key={item.type}
                      onClick={() => setPet(prev => ({ ...prev, type: item.type as any }))}
                      className={cn(
                        "flex flex-col items-center p-4 rounded-2xl transition-all",
                        pet.type === item.type ? "bg-pet-orange text-white pet-shadow" : "bg-pet-cream text-pet-brown/60 hover:bg-pet-pink/20"
                      )}
                    >
                      <span className="text-2xl mb-1">{item.icon}</span>
                      <span className="text-[10px] font-bold">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {onboardingStep === 2 && (
            <motion.div 
              key="step2"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">{t('petImage')}</label>
              <div className="grid grid-cols-2 gap-4">
                <button 
                  onClick={handleRandomizePet}
                  className="flex flex-col items-center justify-center p-6 bg-pet-cream rounded-3xl border-2 border-dashed border-pet-orange/20 hover:border-pet-orange/40 transition-all group"
                >
                  <Dice5 size={32} className="text-pet-orange mb-2 group-hover:rotate-45 transition-transform" />
                  <span className="text-xs font-bold text-pet-brown/60">{t('random')}</span>
                </button>
                <label className="flex flex-col items-center justify-center p-6 bg-pet-cream rounded-3xl border-2 border-dashed border-pet-orange/20 hover:border-pet-orange/40 transition-all cursor-pointer group">
                  <Upload size={32} className="text-pet-orange mb-2 group-hover:-translate-y-1 transition-transform" />
                  <span className="text-xs font-bold text-pet-brown/60">{t('upload')}</span>
                  <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
                </label>
              </div>
              <p className="text-[10px] text-pet-brown/40 text-center">你可以上传真实照片，或者使用 AI 生成的可爱形象</p>
            </motion.div>
          )}

          {onboardingStep === 3 && (
            <motion.div 
              key="step3"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div>
                <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">{t('personality')}</label>
                <textarea 
                  value={pet.personality}
                  onChange={(e) => setPet(prev => ({ ...prev, personality: e.target.value }))}
                  rows={4}
                  className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm resize-none"
                  placeholder="它是一个怎样的伴学官？严厉的、温柔的、还是幽默的？"
                />
              </div>
              <div className="bg-pet-orange/5 p-4 rounded-2xl border border-pet-orange/10">
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles size={14} className="text-pet-orange" />
                  <span className="text-[10px] font-bold text-pet-orange uppercase tracking-wider">档案预览</span>
                </div>
                <p className="text-[10px] text-pet-brown/60 leading-relaxed">
                  该宠物将作为你的“首席伴学官”，在自习时监督你，在聊天时鼓励你。它会根据你设定的性格与你互动。
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex gap-4 pt-4">
          {onboardingStep > 1 && (
            <button 
              onClick={() => setOnboardingStep(prev => prev - 1)}
              className="p-4 bg-pet-cream text-pet-brown/60 rounded-2xl hover:bg-pet-pink/20 transition-colors"
            >
              <ChevronLeft size={24} />
            </button>
          )}
          <button 
            onClick={() => {
              if (onboardingStep < 3) {
                setOnboardingStep(prev => prev + 1);
              } else {
                handleFinishPetProfile();
              }
            }}
            className="flex-1 bg-pet-orange text-white py-4 rounded-2xl font-bold pet-shadow hover:scale-[1.02] transition-transform flex items-center justify-center gap-2"
          >
            {onboardingStep === 3 ? t('startJourney') : t('next')}
            {onboardingStep < 3 && <ChevronRight size={20} />}
          </button>
        </div>
      </div>
    </motion.div>
  );

  if (appStatus === 'landing') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#FFF8F0] via-[#FFF3E8] to-[#FFE8D6] flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* 背景装饰 */}
        <div className="absolute top-0 left-0 w-full h-full pointer-events-none select-none">
          <div className="absolute top-12 left-12 text-pet-orange/8 rotate-12"><PawPrint size={140} /></div>
          <div className="absolute bottom-16 right-12 text-pet-orange/8 -rotate-12"><PawPrint size={180} /></div>
          <div className="absolute top-1/3 right-1/4 text-pet-orange/5"><PawPrint size={90} /></div>
        </div>

        {/* Logo + 标题 */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center mb-10 relative z-10"
        >
          <div className="w-20 h-20 bg-pet-orange rounded-3xl flex items-center justify-center text-white pet-shadow mb-5">
            <PawPrint size={40} />
          </div>
          <h1 className="text-4xl font-display font-bold text-pet-brown tracking-tight">萌爪伴学</h1>
          <p className="text-pet-brown/50 mt-2 text-sm">AI 学习伙伴 · 求职助理 · 自习室</p>
        </motion.div>

        {/* 两条路卡片 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="w-full max-w-sm relative z-10 space-y-4"
        >
          <p className="text-center text-xs text-pet-brown/40 font-semibold uppercase tracking-widest mb-5">选择你的使用方式</p>

          {/* 本地版 */}
          <button
            onClick={() => {
              localStorage.setItem('pawpals_visited', '1');
              setAppStatus('auth');
            }}
            className="w-full bg-white rounded-3xl p-6 pet-shadow flex items-center gap-5 hover:scale-[1.02] transition-transform text-left group"
          >
            <div className="w-14 h-14 bg-pet-orange/12 rounded-2xl flex items-center justify-center shrink-0 group-hover:bg-pet-orange/20 transition-colors">
              <span className="text-2xl">💻</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="font-bold text-pet-brown">本地版</p>
                <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">推荐</span>
              </div>
              <p className="text-xs text-pet-brown/50 leading-relaxed">下载 App，数据存在本机，完全免费，离线可用</p>
            </div>
            <ChevronRight size={18} className="text-pet-brown/30 group-hover:text-pet-orange transition-colors shrink-0" />
          </button>

          {/* 云版 */}
          <a
            href="https://railway.app/new/template?template=https://github.com/salt-byte/pawpals"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full bg-gradient-to-r from-violet-500 to-indigo-600 rounded-3xl p-6 pet-shadow flex items-center gap-5 hover:scale-[1.02] transition-transform text-left group no-underline block"
          >
            <div className="w-14 h-14 bg-white/15 rounded-2xl flex items-center justify-center shrink-0 group-hover:bg-white/25 transition-colors">
              <span className="text-2xl">☁️</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="font-bold text-white">云版</p>
                <span className="text-[10px] bg-white/20 text-white px-2 py-0.5 rounded-full font-semibold flex items-center gap-1">
                  <Zap size={9} /> Railway
                </span>
              </div>
              <p className="text-xs text-white/65 leading-relaxed">一键部署到云端，随时随地用，无需下载，$5/月起</p>
            </div>
            <ChevronRight size={18} className="text-white/40 group-hover:text-white transition-colors shrink-0" />
          </a>

          <p className="text-center text-[11px] text-pet-brown/30 pt-2">
            已有账号？
            <button
              onClick={() => {
                localStorage.setItem('pawpals_visited', '1');
                setAppStatus('auth');
              }}
              className="text-pet-orange underline ml-1"
            >
              直接登录
            </button>
          </p>
        </motion.div>
      </div>
    );
  }

  if (appStatus === 'auth') {
    return (
      <div className="min-h-screen bg-pet-cream flex items-center justify-center p-4 relative overflow-hidden">
        {/* Language Toggle */}
        <div className="absolute top-6 right-6 z-50">
          <button 
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            className="bg-white/80 backdrop-blur-sm p-3 rounded-2xl pet-shadow flex items-center gap-2 text-pet-brown hover:scale-105 transition-transform"
          >
            <Languages size={20} className="text-pet-orange" />
            <span className="text-xs font-bold">{lang === 'zh' ? 'English' : '中文'}</span>
          </button>
        </div>

        {/* Background Paw Prints */}
        <div className="absolute top-10 left-10 text-pet-orange/10 rotate-12"><PawPrint size={120} /></div>
        <div className="absolute bottom-10 right-10 text-pet-orange/10 -rotate-12"><PawPrint size={160} /></div>
        <div className="absolute top-1/2 left-1/4 text-pet-orange/5"><PawPrint size={80} /></div>

        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white rounded-[40px] p-8 md:p-12 pet-shadow relative z-10"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-pet-orange rounded-2xl flex items-center justify-center text-white pet-shadow mb-4">
              <PawPrint size={32} />
            </div>
            <h1 className="text-3xl font-display font-bold text-pet-brown">{t('appTitle')}</h1>
            <p className="text-pet-brown/40 text-sm">{t('appSubtitle')}</p>
          </div>

          <div className="space-y-4">
            <div className="flex bg-pet-cream p-1 rounded-2xl">
              <button 
                onClick={() => setAuthMode('login')}
                className={cn(
                  "flex-1 py-3 rounded-xl text-sm font-bold transition-all",
                  authMode === 'login' ? "bg-white text-pet-brown pet-shadow" : "text-pet-brown/40"
                )}
              >
                {t('login')}
              </button>
              <button 
                onClick={() => setAuthMode('register')}
                className={cn(
                  "flex-1 py-3 rounded-xl text-sm font-bold transition-all",
                  authMode === 'register' ? "bg-white text-pet-brown pet-shadow" : "text-pet-brown/40"
                )}
              >
                {t('register')}
              </button>
            </div>

            <div className="space-y-3">
              <input 
                type="email" 
                placeholder={t('email')}
                className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm"
              />
              <input 
                type="password" 
                placeholder={t('password')}
                className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm"
              />
            </div>

            <button 
              onClick={() => setAppStatus('main')}
              className="w-full bg-pet-orange text-white py-4 rounded-2xl font-bold pet-shadow hover:scale-[1.02] transition-transform flex items-center justify-center gap-2"
            >
              {authMode === 'login' ? <LogIn size={20} /> : <UserPlus size={20} />}
              {authMode === 'login' ? t('loginBtn') : t('registerBtn')}
            </button>

            <div className="relative py-4">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-pet-brown/10"></div></div>
              <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-pet-brown/40">{t('or')}</span></div>
            </div>

            <button
              onClick={() => setAppStatus('main')}
              className="w-full bg-white border-2 border-pet-cream text-pet-brown/60 py-4 rounded-2xl font-bold hover:bg-pet-cream transition-colors"
            >
              {t('guest')}
            </button>
          </div>

        </motion.div>
      </div>
    );
  }

  if (appStatus === 'onboarding') {
    return (
      <div className="min-h-screen bg-pet-cream flex items-center justify-center p-4">
        {renderPetProfileCard()}
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen bg-pet-cream font-sans overflow-hidden relative">
      {/* Global Top-Right Actions */}
      <div className="absolute top-4 right-4 md:top-6 md:right-6 z-50 flex items-center gap-4 md:gap-6">
        {/* Search Button (Contextual or Global) */}
        <button className="text-pet-brown/60 hover:text-pet-orange transition-colors">
          <Search size={22} />
        </button>

        {/* Contacts Button */}
        <button 
          onClick={() => setActiveTab('contacts')}
          className={cn(
            "flex items-center gap-2 transition-colors",
            activeTab === 'contacts' ? "text-pet-orange" : "text-pet-brown/60 hover:text-pet-orange"
          )}
          title={t('contacts')}
        >
          <Users size={22} />
          <span className="hidden lg:inline text-xs font-bold">{t('contacts')}</span>
        </button>

        {/* Notifications Button */}
        <div className="relative">
          <button 
            onClick={() => setShowNotificationsPopover(!showNotificationsPopover)}
            className={cn(
              "transition-colors",
              showNotificationsPopover ? "text-pet-orange" : "text-pet-brown/60 hover:text-pet-orange"
            )}
            title="Notifications"
          >
            <Bell size={22} />
          </button>
          {notifications.some(n => !n.read) && (
            <div className="absolute -top-1 -right-1 w-2 h-2 bg-pet-orange rounded-full border border-pet-cream" />
          )}
        </div>

        {/* Language Toggle */}
        <button 
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          className="flex items-center gap-2 text-pet-brown/60 hover:text-pet-orange transition-colors"
        >
          <Languages size={22} className="text-pet-orange" />
          <span className="text-xs font-bold uppercase">{lang === 'zh' ? 'EN' : 'ZH'}</span>
        </button>
      </div>

      {/* Desktop Sidebar */}
      <nav className="hidden md:flex w-20 bg-white border-r border-pet-pink/30 flex-col items-center py-8 gap-8">
        <div className="w-12 h-12 bg-pet-orange rounded-2xl flex items-center justify-center text-white pet-shadow">
          <PawPrint size={28} />
        </div>
        
        <div className="flex flex-col gap-6 flex-1">
          <NavButton 
            active={activeTab === 'chat'} 
            onClick={() => { setActiveTab('chat'); setShowChatDetail(false); }}
            icon={<MessageCircle size={24} />}
            label={t('chat')}
          />
          <NavButton
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
            icon={<BarChart2 size={24} />}
            label="数据"
          />
          <NavButton 
            active={activeTab === 'pet'} 
            onClick={() => setActiveTab('pet')}
            icon={<Home size={24} />}
            label={t('pet')}
          />
          <NavButton 
            active={activeTab === 'study'} 
            onClick={() => setActiveTab('study')}
            icon={<Timer size={24} />}
            label={t('study')}
          />
          <NavButton
            active={activeTab === 'hole'}
            onClick={() => setActiveTab('hole')}
            icon={<Wind size={24} />}
            label={t('hole')}
          />
          <NavButton
            active={activeTab === 'square'}
            onClick={() => setActiveTab('square')}
            icon={<Globe size={24} />}
            label={t('square')}
          />
          <NavButton
            active={activeTab === 'manage'}
            onClick={() => setActiveTab('manage')}
            icon={<FolderOpen size={24} />}
            label="管理"
          />
        </div>

        <div className="flex flex-col gap-4 items-center relative">
          {/* User Profile Popover */}
          <AnimatePresence>
            {showUserPopover && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9, x: 10 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.9, x: 10 }}
                className="absolute bottom-12 left-0 w-48 bg-white rounded-2xl pet-shadow p-2 z-[60] border border-pet-pink/20"
              >
                <div className="p-3 border-b border-pet-pink/10 mb-1">
                  <div className="text-sm font-bold text-pet-brown">{userProfile.name}</div>
                  <div className="text-[10px] text-pet-brown/40 truncate">{userProfile.signature}</div>
                </div>
                <button 
                  onClick={() => {
                    setShowUserSettings(true);
                    setShowUserPopover(false);
                  }}
                  className="w-full flex items-center gap-3 p-2.5 text-sm text-pet-brown hover:bg-pet-cream rounded-xl transition-colors"
                >
                  <User size={18} className="text-pet-brown/40" />
                  <span>{lang === 'zh' ? '个人设置' : 'User Settings'}</span>
                </button>
                <button
                  onClick={() => {
                    setShowPetSettings(true);
                    setShowUserPopover(false);
                  }}
                  className="w-full flex items-center gap-3 p-2.5 text-sm text-pet-brown hover:bg-pet-cream rounded-xl transition-colors"
                >
                  <Trophy size={18} className="text-pet-brown/40" />
                  <span>{lang === 'zh' ? '首席官设置' : 'Chief Settings'}</span>
                </button>
                <button
                  onClick={() => {
                    const cur = setupState?.primaryModel || '';
                    const [p, m] = cur.split('/');
                    setSwitchProvider(p || '');
                    setSwitchModel(m || '');
                    setSwitchApiKey('');
                    setSwitchBaseUrl('');
                    setSwitchMessage(null);
                    setShowModelSwitch(true);
                    setShowUserPopover(false);
                  }}
                  className="w-full flex items-center gap-3 p-2.5 text-sm text-pet-brown hover:bg-pet-cream rounded-xl transition-colors"
                >
                  <Cpu size={18} className="text-pet-brown/40" />
                  <span>换模型</span>
                </button>
                <button
                  onClick={() => setAppStatus('auth')}
                  className="w-full flex items-center gap-3 p-2.5 text-sm text-red-500 hover:bg-red-50 rounded-xl transition-colors"
                >
                  <LogIn size={18} className="rotate-180" />
                  <span>{lang === 'zh' ? '退出登录' : 'Logout'}</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <button 
            onClick={() => setShowUserPopover(!showUserPopover)}
            className={cn(
              "w-10 h-10 rounded-full overflow-hidden border-2 transition-all hover:scale-105",
              showUserPopover ? "border-pet-orange ring-4 ring-pet-orange/10" : "border-pet-orange"
            )}
          >
            <img src={userProfile.avatar} alt="Avatar" referrerPolicy="no-referrer" />
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 flex overflow-hidden relative">
        {activeTab === 'chat' ? (
          <>
            {/* List Section */}
            <section className={cn(
              "w-full md:w-80 bg-white/50 border-r border-pet-pink/20 flex flex-col transition-all duration-300",
              showChatDetail ? "hidden md:flex" : "flex"
            )}>
              <div className="p-6">
                <div className="flex justify-between items-center mb-4 pr-24">
                  <h1 className="text-2xl font-display font-bold text-pet-brown">{t('chat')}</h1>
                  <div className="md:hidden flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full overflow-hidden border border-pet-orange">
                      <img src={userProfile.avatar} alt="Avatar" referrerPolicy="no-referrer" />
                    </div>
                  </div>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-pet-brown/40" size={18} />
                  <input 
                    type="text" 
                    placeholder={t('searchPlaceholder')} 
                    className="w-full bg-white rounded-xl py-2 pl-10 pr-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm"
                  />
                </div>
                <div className="mt-8 p-4 bg-pet-orange/10 rounded-2xl border border-pet-orange/20 cursor-pointer hover:bg-pet-orange/20 transition-colors" onClick={() => {
                  handleSelectChat(buildChiefChat());
                  setActiveTab('chat');
                }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Trophy size={16} className="text-pet-orange" />
                      <span className="text-[10px] font-bold text-pet-brown/60 uppercase tracking-wider">
                        {lang === 'zh' ? '首席伴学官' : 'Chief Companion'}
                      </span>
                    </div>
                    <button 
                      onClick={() => setShowPetSettings(true)}
                      className="text-pet-brown/40 hover:text-pet-orange transition-colors"
                    >
                      <Settings size={14} />
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-2xl pet-shadow">
                        {pet.type === 'cat' ? '🐈' : pet.type === 'dog' ? '🐕' : '🐇'}
                      </div>
                      <div className="absolute -top-1 -right-1 w-4 h-4 bg-pet-orange text-white text-[8px] flex items-center justify-center rounded-full font-bold border border-white">
                        {pet.level}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-pet-brown truncate">{pet.name}</div>
                      <div className="text-[10px] text-pet-brown/60 truncate">
                        {lang === 'zh' ? '你的专属伴学官，正在陪你变强' : 'Your exclusive companion, growing with you'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-3 pb-24 md:pb-6 space-y-2">
                <div className="px-3 py-2 text-xs font-bold text-pet-brown/40 uppercase tracking-wider">
                  {lang === 'zh' ? '陪伴群组' : 'Study Groups'}
                </div>
                {localizedGroups.map(group => (
                  <ChatListItem 
                    key={group.id}
                    item={group}
                    active={activeChat?.id === group.id}
                    onClick={() => handleSelectChat(group)}
                  />
                ))}
                <div className="px-3 py-2 mt-4 text-xs font-bold text-pet-brown/40 uppercase tracking-wider">
                  {t('myFriends')}
                </div>
                {localizedContacts.map(contact => (
                  <ChatListItem 
                    key={contact.id}
                    item={contact}
                    active={activeChat?.id === contact.id}
                    onClick={() => handleSelectChat(contact)}
                  />
                ))}
              </div>
            </section>

            {/* Chat Window */}
            <section className={cn(
              "flex-1 flex bg-pet-cream/30 transition-all duration-300 overflow-hidden",
              showChatDetail ? "flex" : "hidden md:flex"
            )}>
              {/* 主聊天区 */}
              <div
                className="flex-1 flex flex-col min-w-0 relative"
                onDragOver={(e) => { e.preventDefault(); if (activeChat) setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file && activeChat) await handleDroppedFile(file);
                }}
              >
                {isDragOver && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-pet-orange/10 border-4 border-dashed border-pet-orange rounded-2xl pointer-events-none">
                    <Upload size={48} className="text-pet-orange mb-3" />
                    <p className="text-pet-orange font-bold text-lg">松开即可发送文件</p>
                  </div>
                )}
              {activeChat ? (
                <>
                  <header className="h-16 bg-white/80 backdrop-blur-md border-b border-pet-pink/20 px-4 md:px-6 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setShowChatDetail(false)}
                        className="md:hidden p-2 -ml-2 text-pet-brown/60"
                      >
                        <Plus className="rotate-45" size={24} />
                      </button>
                      <span className="text-2xl hidden sm:inline">{activeChat.icon}</span>
                      <div>
                        <h2 className="font-bold text-pet-brown text-sm md:text-base">{activeChat.name}</h2>
                        <p className="text-[10px] md:text-xs text-pet-brown/60 truncate max-w-[150px] md:max-w-none">{activeChat.description}</p>
                      </div>
                    </div>
                    <div className="flex gap-3 md:gap-4 text-pet-brown/60 items-center pr-24 md:pr-32">
{activeChat?.type === 'group' && (
                        <button
                          onClick={() => setShowMemberPanel(v => !v)}
                          className={cn(
                            "p-2 rounded-xl transition-colors",
                            showMemberPanel ? "bg-pet-orange/15 text-pet-orange" : "text-pet-brown/50 hover:bg-pet-cream hover:text-pet-brown"
                          )}
                          title="查看群成员"
                        >
                          <Users size={18} />
                        </button>
                      )}
                    </div>
                  </header>

                  <div 
                    ref={scrollRef}
                    className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6"
                  >
                    <div className="text-center">
                      <span className="bg-white/50 px-3 py-1 rounded-full text-[10px] text-pet-brown/40 uppercase tracking-widest">
                        欢迎来到 {activeChat.name}
                      </span>
                    </div>
                    
                    {filteredMessages.map((msg) => (
                      <React.Fragment key={msg.id}>
                        {/* Tool activity cards: show activities linked to this message */}
                        {filteredActivities
                          .filter(a => a.msgId === msg.id)
                          .map(activity => (
                            <ToolActivityCard key={activity.id} activity={activity} />
                          ))
                        }
                      <div
                        className={cn(
                          "group flex gap-3 max-w-[90%] md:max-w-[80%]",
                          msg.sender === userProfile.name ? "ml-auto flex-row-reverse" : ""
                        )}
                      >
                        <img
                          src={msg.avatar}
                          alt={msg.sender}
                          className="w-8 h-8 md:w-10 md:h-10 rounded-xl md:rounded-2xl bg-white p-1"
                          referrerPolicy="no-referrer"
                        />
                        <div className={cn(
                          "flex flex-col",
                          msg.sender === userProfile.name ? "items-end" : "items-start"
                        )}>
                          <div className="flex items-center gap-1 mb-1 px-1">
                            <span className="text-[10px] text-pet-brown/40">{msg.sender}</span>
                            {msg.isBot && (
                              <span className="bg-pet-orange/20 text-pet-orange text-[8px] px-1 rounded font-bold uppercase tracking-tighter">
                                PawPals Bot
                              </span>
                            )}
                          </div>
                          <div className={cn(
                            "px-4 py-2 rounded-2xl text-sm shadow-sm relative",
                            msg.sender === userProfile.name
                              ? "bg-pet-orange text-white rounded-tr-none"
                              : "bg-white text-pet-brown rounded-tl-none"
                          )}>
                            {msg.isLoading ? (
                              <span className="flex items-center gap-1 py-1">
                                <span className="w-2 h-2 rounded-full bg-pet-brown/30 animate-bounce" style={{animationDelay:'0ms'}}/>
                                <span className="w-2 h-2 rounded-full bg-pet-brown/30 animate-bounce" style={{animationDelay:'150ms'}}/>
                                <span className="w-2 h-2 rounded-full bg-pet-brown/30 animate-bounce" style={{animationDelay:'300ms'}}/>
                              </span>
                            ) : (
                              <Markdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                  table: ({children}) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{children}</table></div>,
                                  thead: ({children}) => <thead className={msg.sender === userProfile.name ? "bg-white/20" : "bg-pet-orange/10"}>{children}</thead>,
                                  tbody: ({children}) => <tbody>{children}</tbody>,
                                  tr: ({children}) => <tr className="border-b border-current/10">{children}</tr>,
                                  th: ({children}) => <th className="px-2 py-1 text-left font-semibold whitespace-nowrap">{children}</th>,
                                  td: ({children}) => <td className="px-2 py-1 whitespace-nowrap">{children}</td>,
                                  p: ({children}) => <p className="mb-1 last:mb-0 leading-relaxed">{children}</p>,
                                  strong: ({children}) => <strong className="font-bold">{children}</strong>,
                                  em: ({children}) => <em className="italic">{children}</em>,
                                  ul: ({children}) => <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>,
                                  ol: ({children}) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>,
                                  li: ({children}) => <li className="leading-relaxed">{children}</li>,
                                  h1: ({children}) => <h1 className="font-bold text-base mb-1">{children}</h1>,
                                  h2: ({children}) => <h2 className="font-bold mb-1">{children}</h2>,
                                  h3: ({children}) => <h3 className="font-semibold mb-0.5">{children}</h3>,
                                  code: ({children}) => <code className="bg-black/10 rounded px-1 text-xs font-mono">{children}</code>,
                                  hr: () => <hr className="border-current opacity-20 my-2" />,
                                  a: ({href, children}) => <a href={href} target="_blank" rel="noopener noreferrer" className="underline opacity-80 hover:opacity-100">{children}</a>,
                                  // @mentions 高亮
                                  text: ({children}) => {
                                    const str = String(children);
                                    const parts = str.split(/(@[\u4e00-\u9fa5A-Za-z\d]+)/g);
                                    if (parts.length === 1) return <>{str}</>;
                                    return <>{parts.map((p, i) => p.startsWith('@')
                                      ? <span key={i} className={cn("font-bold rounded px-0.5", msg.sender === userProfile.name ? "text-yellow-300" : "text-pet-orange/90 bg-pet-orange/10")}>{p}</span>
                                      : p
                                    )}</>;
                                  },
                                }}
                              >
                                {msg.content}
                              </Markdown>
                            )}
                            <div className={cn(
                              "absolute -bottom-1 -right-1 opacity-20",
                              msg.sender === userProfile.name ? "text-white" : "text-pet-orange"
                            )}>
                              <PawPrint size={12} />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[9px] text-pet-brown/30">
                              {format(new Date(msg.timestamp), 'HH:mm')}
                            </span>
                            {!msg.isLoading && (
                              <button
                                onClick={() => setReplyTo({ id: msg.id, sender: msg.sender, content: msg.content })}
                                className="opacity-0 group-hover:opacity-100 transition-opacity text-[9px] text-pet-brown/40 hover:text-pet-orange flex items-center gap-0.5"
                              >
                                <CornerUpLeft size={10} /> 回复
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      </React.Fragment>
                    ))}
                  </div>

                  <footer className="p-4 md:p-6 bg-white/50 pb-20 md:pb-6">
                    {/* Boss直聘 登录按钮 — only in job group */}
                    {activeChat?.id === 'job' && (
                      <div className="mb-2 flex items-center gap-2 flex-wrap">
                        <button
                          onClick={async () => {
                            setBossLoginStatus('loading');
                            try {
                              await fetch('/api/boss-login', { method: 'POST' });
                            } catch { setBossLoginStatus('error'); setTimeout(() => setBossLoginStatus('idle'), 4000); }
                          }}
                          disabled={bossLoginStatus === 'loading' || bossLoginStatus === 'ok'}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all
                            ${bossLoginStatus === 'ok' ? 'bg-green-100 text-green-700' :
                              bossLoginStatus === 'error' ? 'bg-red-100 text-red-600' :
                              'bg-pet-cream text-pet-brown hover:bg-pet-brown/10'}`}
                        >
                          {bossLoginStatus === 'ok' ? '✅ 已登录 Boss直聘' :
                           bossLoginStatus === 'error' ? '❌ 失败，重试' : '🔑 登录 Boss直聘'}
                        </button>

                        {bossLoginStatus === 'loading' && (
                          <span className="text-xs text-pet-brown/50 animate-pulse">浏览器已打开，请完成登录，检测到登录成功后会自动关闭...</span>
                        )}
                      </div>
                    )}
                    {/* @ Mention Picker — only in job group */}
                    {activeChat?.type === 'group' && mentionPicker.visible && (() => {
                      const agents = GROUP_AGENTS[activeChat.id] || [];
                      const filtered = agents.filter(a => a.name.includes(mentionPicker.query));
                      return filtered.length > 0 ? (
                        <div className="mb-2 bg-white rounded-2xl pet-shadow overflow-hidden border border-pet-pink/20">
                          {filtered.map((a, i) => (
                            <div
                              key={a.name}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                const atPos = inputValue.lastIndexOf('@');
                                setInputValue(inputValue.slice(0, atPos) + '@' + a.name + ' ');
                                setMentionPicker({ visible: false, query: '', idx: 0 });
                              }}
                              className={cn(
                                'flex items-center gap-2 px-4 py-2 cursor-pointer text-sm',
                                (a as any).isAll
                                  ? 'border-b border-gray-100 font-bold text-white bg-pet-brown'
                                  : 'text-pet-brown',
                                !(a as any).isAll && (i === mentionPicker.idx ? 'bg-pet-orange/15' : 'hover:bg-pet-cream')
                              )}
                            >
                              <span>{a.emoji}</span>
                              <span>{(a as any).isAll ? 'all — 通知所有助手' : a.name}</span>
                            </div>
                          ))}
                        </div>
                      ) : null;
                    })()}
                    {replyTo && (
                      <div className="mb-2 flex items-center gap-2 bg-pet-orange/10 rounded-xl px-3 py-2 text-xs text-pet-brown/70">
                        <CornerUpLeft size={12} className="text-pet-orange shrink-0" />
                        <span className="flex-1 truncate">
                          <span className="font-semibold text-pet-orange">{replyTo.sender}：</span>
                          {replyTo.content.replace(/\n/g, ' ').slice(0, 60)}{replyTo.content.length > 60 ? '…' : ''}
                        </span>
                        <button onClick={() => setReplyTo(null)} className="shrink-0 text-pet-brown/40 hover:text-pet-brown">✕</button>
                      </div>
                    )}
                    {attachedFile && (
                      <div className="flex items-center gap-2 bg-white rounded-xl px-3 py-1.5 mb-1 pet-shadow text-xs text-pet-brown">
                        <Paperclip size={13} className="text-pet-orange shrink-0" />
                        <span className="truncate max-w-[200px]">{attachedFile.name}</span>
                        <button type="button" onClick={() => setAttachedFile(null)} className="text-pet-brown/40 hover:text-pet-brown shrink-0">
                          <X size={13} />
                        </button>
                      </div>
                    )}
                    {attachedImage && (
                      <div className="flex items-center gap-2 bg-white rounded-xl px-2 py-1.5 mb-1 pet-shadow">
                        <img src={attachedImage.dataUrl} className="w-10 h-10 rounded-lg object-cover shrink-0" />
                        <span className="text-xs text-pet-brown truncate max-w-[160px]">{attachedImage.name}</span>
                        <button type="button" onClick={() => setAttachedImage(null)} className="text-pet-brown/40 hover:text-pet-brown shrink-0">
                          <X size={13} />
                        </button>
                      </div>
                    )}
                    <form
                      onSubmit={handleSendMessage}
                      className="bg-white rounded-2xl p-2 flex items-center gap-2 pet-shadow"
                    >
                      <input type="file" ref={fileInputRef} onChange={handleFileAttach} className="hidden"
                        accept=".pdf,.docx,.txt,.md,.csv,.json,.ts,.js,.py,.html,.css,.xml,.yaml,.yml,.log,.env,.sh,image/*" />
                      <button type="button" onClick={() => fileInputRef.current?.click()} className="p-2 text-pet-brown/40 hover:text-pet-orange transition-colors">
                        <Paperclip size={20} />
                      </button>
                      <button type="button" className="p-2 text-pet-brown/40 hover:text-pet-orange transition-colors">
                        <Smile size={20} />
                      </button>
                      <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => {
                          const val = e.target.value;
                          setInputValue(val);
                          if (activeChat?.type === 'group') {
                            const atPos = val.lastIndexOf('@');
                            if (atPos >= 0) {
                              const query = val.slice(atPos + 1);
                              if (!query.includes(' ')) {
                                setMentionPicker({ visible: true, query, idx: 0 });
                                return;
                              }
                            }
                          }
                          setMentionPicker({ visible: false, query: '', idx: 0 });
                        }}
                        onKeyDown={(e) => {
                          if (!mentionPicker.visible) return;
                          const filtered = (GROUP_AGENTS[activeChat?.id || ''] || []).filter(a => a.name.includes(mentionPicker.query));
                          if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setMentionPicker(p => ({ ...p, idx: (p.idx + 1) % filtered.length }));
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setMentionPicker(p => ({ ...p, idx: (p.idx - 1 + filtered.length) % filtered.length }));
                          } else if (e.key === 'Enter' || e.key === 'Tab') {
                            if (filtered[mentionPicker.idx]) {
                              e.preventDefault();
                              const atPos = inputValue.lastIndexOf('@');
                              setInputValue(inputValue.slice(0, atPos) + '@' + filtered[mentionPicker.idx].name + ' ');
                              setMentionPicker({ visible: false, query: '', idx: 0 });
                            }
                          } else if (e.key === 'Escape') {
                            setMentionPicker({ visible: false, query: '', idx: 0 });
                          }
                        }}
                        placeholder={activeChat?.type === 'group' ? '发消息，@ 呼叫 Agent...' : (lang === 'zh' ? '输入治愈的话语...' : 'Type healing words...')}
                        className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-2"
                      />
                      <button
                        type="submit"
                        disabled={!inputValue.trim() && !attachedFile && !attachedImage}
                        className="bg-pet-orange text-white p-2 rounded-xl hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                      >
                        <Send size={20} />
                      </button>
                    </form>
                  </footer>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-pet-brown/40 gap-4">
                  <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center text-4xl pet-shadow">
                    🐾
                  </div>
                  <p>{lang === 'zh' ? '选择一个群聊开始陪伴吧' : 'Select a chat to start companionship'}</p>
                </div>
              )}
              </div>

              {/* 群成员侧边面板 */}
              <AnimatePresence>
                {showMemberPanel && activeChat?.type === 'group' && (
                  <motion.div
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: 240, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="bg-white border-l border-pet-pink/20 flex flex-col overflow-hidden shrink-0"
                  >
                    <div className="px-4 py-3 border-b border-pet-pink/10">
                      <h3 className="text-xs font-bold text-pet-brown/50 uppercase tracking-wider">群成员</h3>
                      <p className="text-[10px] text-pet-brown/30 mt-0.5">{(GROUP_AGENTS[activeChat.id] || []).filter(a => !(a as any).isAll).length} 位 AI 助手</p>
                    </div>
                    <div className="flex-1 overflow-y-auto py-2">
                      {(GROUP_AGENTS[activeChat.id] || [])
                        .filter(a => !(a as any).isAll)
                        .map(agent => (
                          <div
                            key={agent.name}
                            className="flex items-start gap-2.5 px-4 py-2.5 hover:bg-pet-cream/50 transition-colors cursor-default"
                          >
                            <div className="w-8 h-8 rounded-xl bg-pet-orange/10 flex items-center justify-center text-base shrink-0 mt-0.5">
                              {agent.emoji}
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-pet-brown truncate">{agent.name}</div>
                              <div className="text-[10px] text-pet-brown/40 leading-tight mt-0.5 line-clamp-2">{(agent as any).role || ''}</div>
                            </div>
                          </div>
                        ))}
                    </div>
                    <div className="px-4 py-3 border-t border-pet-pink/10">
                      <p className="text-[10px] text-pet-brown/30 text-center">@ 呼叫助手参与对话</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </>
        ) : activeTab === 'contacts' ? (
          /* Contacts Section */
          <section className="flex-1 flex flex-col p-6 md:p-12 overflow-y-auto pb-24 md:pb-12">
            <div className="max-w-2xl mx-auto w-full space-y-8">
              <div className="flex items-center justify-between">
                <h1 className="text-3xl font-display font-bold text-pet-brown">{t('myFriends')}</h1>
                <div className="bg-pet-orange/10 text-pet-orange px-4 py-1 rounded-full text-xs font-bold">
                  {INITIAL_CONTACTS.length} {t('friendsCount')}
                </div>
              </div>

              <div className="grid gap-4">
                {localizedContacts.map(contact => (
                  <motion.div
                    key={contact.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => {
                      handleSelectChat(contact);
                      setActiveTab('chat');
                    }}
                    className="bg-white rounded-3xl p-6 flex items-center gap-6 pet-shadow hover:scale-[1.02] transition-transform cursor-pointer group"
                  >
                    <div className="w-16 h-16 bg-pet-cream rounded-2xl flex items-center justify-center text-4xl group-hover:scale-110 transition-transform">
                      {contact.icon}
                    </div>
                    <div className="flex-1">
                      <h3 className="text-lg font-bold text-pet-brown">{contact.name}</h3>
                      <p className="text-sm text-pet-brown/60">{contact.description}</p>
                    </div>
                    <div className="text-pet-orange opacity-0 group-hover:opacity-100 transition-opacity">
                      <MessageCircle size={24} />
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>
        ) : activeTab === 'pet' ? (
          /* Pet House Section */
          <section className="flex-1 flex flex-col p-6 md:p-12 overflow-y-auto pb-24 md:pb-12">
            <div className="max-w-4xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-12">
              <div className="flex flex-col items-center gap-8">
                <div className="relative">
                  <motion.div 
                    animate={{ y: [0, -10, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="text-[120px] md:text-[160px] drop-shadow-2xl"
                  >
                    {pet.type === 'cat' ? '🐈' : pet.type === 'dog' ? '🐕' : '🐇'}
                  </motion.div>
                  <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 w-32 h-4 bg-pet-brown/10 rounded-full blur-md" />
                </div>
                
                <div className="w-full healing-card p-8 text-center">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <Trophy size={16} className="text-pet-orange" />
                    <span className="text-[10px] font-bold text-pet-orange uppercase tracking-widest">首席伴学官指导中</span>
                  </div>
                  <div className="relative inline-block mb-4">
                    <img 
                      src={pet.avatar} 
                      alt="Pet" 
                      className="w-32 h-32 mx-auto rounded-3xl bg-white p-2 pet-shadow object-cover"
                      referrerPolicy="no-referrer"
                    />
                    <button 
                      onClick={() => setShowPetSettings(true)}
                      className="absolute -bottom-2 -right-2 bg-pet-orange text-white p-2 rounded-full pet-shadow hover:scale-110 transition-transform"
                    >
                      <Settings size={16} />
                    </button>
                  </div>
                  <h2 className="text-3xl font-display font-bold text-pet-brown mb-2">{pet.name}</h2>
                  <div className="flex items-center justify-center gap-2 mb-4">
                    <span className="bg-pet-orange text-white text-xs font-bold px-2 py-0.5 rounded-full">Lv.{pet.level}</span>
                    <span className="text-xs text-pet-brown/60">首席伴学官</span>
                  </div>
                  <p className="text-sm text-pet-brown/60 italic max-w-xs mx-auto mb-6">
                    “{pet.personality}”
                  </p>
                  
                  <div className="space-y-4">
                    <div className="flex justify-between text-xs font-bold text-pet-brown/60 mb-1">
                      <span>{lang === 'zh' ? '能量值' : 'Energy'}</span>
                      <span>{pet.energy}%</span>
                    </div>
                    <div className="w-full h-3 bg-pet-cream rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: 0 }}
                        animate={{ width: `${pet.energy}%` }}
                        className="h-full bg-pet-orange"
                      />
                    </div>
                  </div>
                </div>

                {/* Pet Archive Card */}
                <div className="w-full healing-card p-6 space-y-4">
                  <h3 className="text-sm font-bold text-pet-brown flex items-center gap-2">
                    <BookOpen size={16} className="text-pet-orange" />
                    {t('archive')}
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-pet-cream/50 p-3 rounded-2xl">
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase">{t('joinTime')}</div>
                      <div className="text-xs font-bold text-pet-brown">2026-03-11</div>
                    </div>
                    <div className="bg-pet-cream/50 p-3 rounded-2xl">
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase">{t('studyDuration')}</div>
                      <div className="text-xs font-bold text-pet-brown">128 小时</div>
                    </div>
                    <div className="bg-pet-cream/50 p-3 rounded-2xl">
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase">{t('problemsSolved')}</div>
                      <div className="text-xs font-bold text-pet-brown">42 个</div>
                    </div>
                    <div className="bg-pet-cream/50 p-3 rounded-2xl">
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase">{t('moodIndex')}</div>
                      <div className="text-xs font-bold text-pet-brown">{t('happy')} 🌟</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-8">
                <div>
                  <h3 className="text-xl font-display font-bold text-pet-brown mb-4 flex items-center gap-2">
                    <CheckCircle2 className="text-pet-orange" />
                    {lang === 'zh' ? '伴学任务' : 'Study Tasks'}
                  </h3>
                  <div className="space-y-3">
                    {tasks.map(task => (
                      <button 
                        key={task.id}
                        onClick={() => handleToggleTask(task.id)}
                        disabled={task.completed}
                        className={cn(
                          "w-full healing-card p-4 flex items-center justify-between transition-all",
                          task.completed ? "opacity-50 grayscale" : "hover:bg-white"
                        )}
                      >
                        <div className="flex items-center gap-3">
                          {task.completed ? <CheckCircle2 className="text-pet-mint" /> : <Circle className="text-pet-brown/20" />}
                          <span className={cn("text-sm font-medium", task.completed ? "line-through" : "")}>{task.title}</span>
                        </div>
                        <span className="text-xs font-bold text-pet-orange">+{task.energyReward} {lang === 'zh' ? '能量' : 'Energy'}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="healing-card p-6">
                  <h3 className="text-sm font-bold text-pet-brown mb-4 uppercase tracking-wider">
                    {lang === 'zh' ? '宠物商店' : 'Pet Shop'}
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    {['🐟', '🦴', '🥕'].map((item, i) => (
                      <div key={i} className="aspect-square bg-pet-cream rounded-2xl flex items-center justify-center text-2xl hover:bg-pet-pink/20 cursor-pointer transition-colors">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : activeTab === 'study' ? (
          /* Virtual Study Room Section */
          <section className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex flex-col md:flex-row">
              {/* Timer Section */}
              <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white/30">
                <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
                  <svg className="absolute inset-0 w-full h-full -rotate-90">
                    <circle 
                      cx="50%" cy="50%" r="48%" 
                      className="fill-none stroke-pet-cream stroke-[4%]"
                    />
                    <motion.circle 
                      cx="50%" cy="50%" r="48%" 
                      className="fill-none stroke-pet-orange stroke-[4%]"
                      strokeDasharray="100 100"
                      animate={{ strokeDashoffset: 100 - (timeLeft / (25 * 60)) * 100 }}
                    />
                  </svg>
                  <div className="text-center">
                    <div className="text-6xl md:text-7xl font-display font-bold text-pet-brown">
                      {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
                    </div>
                    <p className="text-sm text-pet-brown/40 mt-2 uppercase tracking-widest">
                      {isTimerRunning ? (lang === 'zh' ? '专注中...' : 'Focusing...') : (lang === 'zh' ? '准备好了吗？' : 'Ready?')}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-6 mt-12">
                  <button 
                    onClick={() => setIsMuted(!isMuted)}
                    className="p-4 rounded-full bg-white text-pet-brown/40 hover:text-pet-orange transition-colors"
                  >
                    {isMuted ? <VolumeX size={24} /> : <Volume2 size={24} />}
                  </button>
                  <button 
                    onClick={toggleTimer}
                    className={cn(
                      "px-12 py-4 rounded-full font-bold text-lg pet-shadow transition-all hover:scale-105",
                      isTimerRunning ? "bg-pet-pink text-pet-brown" : "bg-pet-orange text-white"
                    )}
                  >
                    {isTimerRunning ? t('stopStudy') : t('startStudy')}
                  </button>
                  <button className="p-4 rounded-full bg-white text-pet-brown/40 hover:text-pet-orange transition-colors">
                    <Coffee size={24} />
                  </button>
                </div>
              </div>

              {/* Active Users Section */}
              <div className="w-full md:w-80 bg-white/50 border-l border-pet-pink/20 p-6 overflow-y-auto pb-24 md:pb-6">
                <h3 className="text-sm font-bold text-pet-brown/40 uppercase tracking-wider mb-6">
                  {lang === 'zh' ? '在线研友' : 'Online Pals'} ({studyRoomUsers.length})
                </h3>
                <div className="space-y-4">
                  {studyRoomUsers.map((user, i) => (
                    <motion.div 
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      key={i} 
                      className="flex items-center gap-3 p-3 bg-white rounded-2xl pet-shadow"
                    >
                      <div className="relative">
                        <img src={user.avatar} className="w-10 h-10 rounded-xl" referrerPolicy="no-referrer" />
                        <span className="absolute -bottom-1 -right-1 text-sm">{user.petIcon}</span>
                      </div>
                      <div>
                        <div className="text-xs font-bold text-pet-brown">{user.userName}</div>
                        <div className="text-[10px] text-pet-mint font-bold">
                          {lang === 'zh' ? '专注中...' : 'Focusing...'}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : activeTab === 'dashboard' ? (
          /* Dashboard Section */
          <section className="flex-1 flex flex-col overflow-y-auto pb-24 md:pb-8">
            <header className="p-6 md:p-8 bg-white/50 pr-24 md:pr-40">
              <h1 className="text-3xl md:text-4xl font-display font-bold text-pet-brown mb-1">AI 控制台</h1>
              <p className="text-sm text-pet-brown/60">查看你的 AI 团队状态、用量统计和各项配置</p>
            </header>

            {/* Dashboard Body */}
            <div className="p-6 md:p-8 space-y-6">
              {dashLoading && (
                <div className="flex items-center justify-center gap-3 py-12 text-pet-brown/50">
                  <div className="w-5 h-5 border-2 border-pet-orange/40 border-t-pet-orange rounded-full animate-spin" />
                  <span className="text-sm">加载中…</span>
                </div>
              )}
              {dashError && (
                <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-600">
                  <AlertCircle size={18} />
                  {dashError}
                </div>
              )}

              {/* Stats Row */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'AI 成员', value: dashAgents.length, icon: <Bot size={18} />, color: 'bg-pet-orange/10 text-pet-orange' },
                  { label: '定时提醒', value: dashCron.length, icon: <Clock size={18} />, color: 'bg-purple-100 text-purple-600' },
                  { label: '已用 Token', value: dashTotalTokens > 0 ? (dashTotalTokens >= 1000 ? `${(dashTotalTokens/1000).toFixed(1)}k` : dashTotalTokens.toString()) : '—', icon: <Zap size={18} />, color: 'bg-amber-100 text-amber-600' },
                  { label: '累计消费', value: dashTotalCost > 0 ? `$${dashTotalCost.toFixed(3)}` : '—', icon: <BarChart2 size={18} />, color: 'bg-emerald-100 text-emerald-600' },
                ].map(stat => (
                  <div key={stat.label} className="healing-card p-5 flex flex-col gap-3">
                    <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center', stat.color)}>{stat.icon}</div>
                    <div>
                      <div className="text-2xl font-display font-bold text-pet-brown">{stat.value}</div>
                      <div className="text-xs text-pet-brown/50 mt-0.5">{stat.label}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* AI 团队 */}
                <div className="healing-card p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <Bot size={18} className="text-pet-orange" />
                    <h2 className="font-bold text-pet-brown">AI 成员列表</h2>
                  </div>
                  {dashAgents.length === 0 && !dashLoading ? (
                    <p className="text-sm text-pet-brown/40">暂无 Agent 数据（AI 服务可能未启动）</p>
                  ) : (
                    <div className="space-y-2">
                      {dashAgents.map((agent: any) => (
                        <div key={agent.id} className="flex items-center gap-3 p-3 bg-pet-cream/60 rounded-xl">
                          <div className="w-8 h-8 bg-pet-orange/20 rounded-lg flex items-center justify-center text-pet-orange font-bold text-sm">
                            {agent.name?.slice(0, 1) || 'A'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-pet-brown truncate">{agent.name || agent.id}</div>
                            <div className="text-[11px] text-pet-brown/40 truncate">{agent.modelDisplay || agent.id}</div>
                          </div>
                          {agent.isDefault && (
                            <span className="text-[10px] bg-pet-orange text-white px-2 py-0.5 rounded-full font-bold shrink-0">默认</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 定时提醒 */}
                <div className="healing-card p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Clock size={18} className="text-purple-500" />
                      <h2 className="font-bold text-pet-brown">定时提醒</h2>
                    </div>
                    <button
                      onClick={() => setShowAddCron(v => !v)}
                      className="text-xs font-bold text-pet-orange flex items-center gap-1 hover:underline"
                    >
                      <Plus size={14} /> 新增
                    </button>
                  </div>
                  {showAddCron && (
                    <div className="bg-pet-cream/60 rounded-xl p-4 space-y-3">
                      <input value={cronNewName} onChange={e => setCronNewName(e.target.value)} placeholder="提醒名称" className="w-full bg-white rounded-xl border border-pet-pink/30 px-3 py-2 text-sm focus:ring-2 focus:ring-pet-orange/30 focus:outline-none" />
                      <input value={cronNewMsg} onChange={e => setCronNewMsg(e.target.value)} placeholder="提醒内容（发给 AI）" className="w-full bg-white rounded-xl border border-pet-pink/30 px-3 py-2 text-sm focus:ring-2 focus:ring-pet-orange/30 focus:outline-none" />
                      <input value={cronNewSchedule} onChange={e => setCronNewSchedule(e.target.value)} placeholder="Cron 表达式，如 0 9 * * *" className="w-full bg-white rounded-xl border border-pet-pink/30 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-pet-orange/30 focus:outline-none" />
                      <button onClick={handleCronAdd} disabled={cronAdding} className="w-full bg-pet-orange text-white rounded-xl py-2 text-sm font-bold disabled:opacity-50">
                        {cronAdding ? '保存中…' : '保存提醒'}
                      </button>
                    </div>
                  )}
                  {dashCron.length === 0 && !dashLoading ? (
                    <p className="text-sm text-pet-brown/40">暂无定时提醒</p>
                  ) : (
                    <div className="space-y-2">
                      {dashCron.map((job: any) => (
                        <div key={job.id} className="flex items-center gap-3 p-3 bg-pet-cream/60 rounded-xl">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-pet-brown truncate">{job.name}</div>
                            <div className="text-[11px] text-pet-brown/40 truncate">{typeof job.schedule === 'string' ? job.schedule : JSON.stringify(job.schedule)}</div>
                          </div>
                          <button onClick={() => handleCronToggle(job.id, !job.enabled)} className="text-pet-brown/40 hover:text-pet-orange transition-colors">
                            {job.enabled ? <ToggleRight size={22} className="text-pet-orange" /> : <ToggleLeft size={22} />}
                          </button>
                          <button onClick={() => handleCronDelete(job.id)} className="text-pet-brown/30 hover:text-red-400 transition-colors">
                            <Trash2 size={16} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 用量记录 */}
              {dashUsage.length > 0 && (
                <div className="healing-card p-6 space-y-4">
                  <div className="flex items-center gap-2">
                    <Zap size={18} className="text-amber-500" />
                    <h2 className="font-bold text-pet-brown">近期用量记录</h2>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-pet-pink/20">
                    <table className="w-full text-xs">
                      <thead className="bg-pet-cream/60">
                        <tr>
                          <th className="px-4 py-2 text-left text-pet-brown/50 font-bold uppercase tracking-wide">时间</th>
                          <th className="px-4 py-2 text-left text-pet-brown/50 font-bold uppercase tracking-wide">Agent</th>
                          <th className="px-4 py-2 text-left text-pet-brown/50 font-bold uppercase tracking-wide">模型</th>
                          <th className="px-4 py-2 text-right text-pet-brown/50 font-bold uppercase tracking-wide">Token</th>
                          <th className="px-4 py-2 text-right text-pet-brown/50 font-bold uppercase tracking-wide">费用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashUsage.slice(0, 10).map((entry: any, i: number) => (
                          <tr key={i} className="border-t border-pet-pink/10 hover:bg-pet-cream/30 transition-colors">
                            <td className="px-4 py-2 text-pet-brown/60 whitespace-nowrap">{entry.timestamp ? format(new Date(entry.timestamp), 'MM-dd HH:mm') : '—'}</td>
                            <td className="px-4 py-2 text-pet-brown font-medium">{entry.agentId || '—'}</td>
                            <td className="px-4 py-2 text-pet-brown/60 truncate max-w-[120px]">{entry.model || '—'}</td>
                            <td className="px-4 py-2 text-right text-pet-brown font-mono">{entry.totalTokens?.toLocaleString() || '—'}</td>
                            <td className="px-4 py-2 text-right text-emerald-600 font-mono">{entry.costUsd != null ? `$${entry.costUsd.toFixed(4)}` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 数据备份 */}
              <div className="healing-card p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Download size={18} className="text-pet-orange" />
                    <h2 className="font-bold text-pet-brown">数据备份</h2>
                  </div>
                  <span className="text-xs text-pet-brown/50">每小时自动备份到本地</span>
                </div>
                {/* 备份状态 + 立即备份 */}
                <div className="flex items-center justify-between bg-pet-orange/5 rounded-xl p-3">
                  <div>
                    <p className="text-sm text-pet-brown font-medium">
                      {backupStatus?.lastBackupAt
                        ? `上次备份：${new Date(backupStatus.lastBackupAt).toLocaleString('zh-CN')}`
                        : '尚未备份'}
                    </p>
                    <p className="text-xs text-pet-brown/50 mt-0.5">
                      共 {backupStatus?.snapshots?.length || 0} 份快照 · 保存在「文稿/PawPals备份」
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      setBackingUp(true);
                      try {
                        const r = await fetch('/api/backup/now', { method: 'POST' });
                        const d = await r.json();
                        if (d.ok) {
                          const r2 = await fetch('/api/backup/status');
                          setBackupStatus(await r2.json());
                        }
                      } finally { setBackingUp(false); }
                    }}
                    disabled={backingUp}
                    className="text-xs bg-pet-orange text-white px-3 py-1.5 rounded-lg hover:bg-pet-orange/90 disabled:opacity-50 shrink-0"
                  >
                    {backingUp ? '备份中...' : '立即备份'}
                  </button>
                </div>
                {/* 版本历史列表 */}
                {backupStatus?.snapshots?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-pet-brown/60 uppercase tracking-wide">版本历史</p>
                    <div className="max-h-52 overflow-y-auto rounded-xl border border-pet-pink/20 divide-y divide-pet-pink/10">
                      {backupStatus.snapshots.map((snap: any, idx: number) => {
                        const label = snap.name.replace('T', ' ').replace(/-(\d{2})-(\d{2})$/, ' $1:$2');
                        return (
                          <div key={snap.name} className="flex items-center gap-3 px-3 py-2 hover:bg-pet-orange/5 transition-colors">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium text-pet-brown truncate">
                                {idx === 0 ? '🟢 ' : ''}{label}
                              </p>
                              {snap.sizeKb > 0 && (
                                <p className="text-[10px] text-pet-brown/40">{snap.sizeKb} KB</p>
                              )}
                            </div>
                            <button
                              onClick={async () => {
                                if (!confirm(`确认恢复到「${label}」？当前状态会先自动备份。`)) return;
                                setRestoringSnapshot(snap.name);
                                try {
                                  const r = await fetch(`/api/backup/restore/${encodeURIComponent(snap.name)}`, { method: 'POST' });
                                  const d = await r.json();
                                  alert(d.message || (d.error ? `失败：${d.error}` : '恢复完成'));
                                  if (d.ok) {
                                    const r2 = await fetch('/api/backup/status');
                                    setBackupStatus(await r2.json());
                                  }
                                } finally { setRestoringSnapshot(null); }
                              }}
                              disabled={restoringSnapshot === snap.name}
                              className="text-[10px] border border-pet-orange/40 text-pet-orange px-2 py-0.5 rounded-lg hover:bg-pet-orange/10 disabled:opacity-40 shrink-0"
                            >
                              {restoringSnapshot === snap.name ? '恢复中...' : '恢复'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                <a
                  href="/api/backup/export"
                  download
                  className="flex items-center justify-center gap-2 w-full py-2.5 border-2 border-dashed border-pet-orange/30 rounded-xl text-pet-brown/60 hover:border-pet-orange hover:text-pet-orange transition-colors text-sm"
                >
                  <Download size={15} />
                  导出全部数据（ZIP）
                </a>
                {/* Step 8：Secrets 脱敏 */}
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-amber-500 text-sm">🔐</span>
                    <p className="text-xs font-semibold text-amber-700">API Key 安全脱敏</p>
                  </div>
                  <p className="text-[11px] text-amber-600">扫描配置文件中的明文 API Key，自动替换为环境变量引用，提升安全性。</p>
                  {sanitizeResult && (
                    <p className="text-[11px] text-green-700 bg-green-50 rounded px-2 py-1">{sanitizeResult}</p>
                  )}
                  <button
                    onClick={async () => {
                      setSanitizing(true);
                      setSanitizeResult(null);
                      try {
                        const r = await fetch('/api/secrets/sanitize', { method: 'POST' });
                        const d = await r.json();
                        setSanitizeResult(d.message || (d.error ? `失败：${d.error}` : '完成'));
                      } finally { setSanitizing(false); }
                    }}
                    disabled={sanitizing}
                    className="text-xs bg-amber-500 text-white px-3 py-1.5 rounded-lg hover:bg-amber-600 disabled:opacity-50"
                  >
                    {sanitizing ? '扫描中...' : '一键脱敏'}
                  </button>
                </div>
              </div>

              {/* API 连接测试 */}
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-blue-500 text-sm">🔌</span>
                      <p className="text-xs font-semibold text-blue-700">API 连接测试</p>
                    </div>
                    <button
                      onClick={async () => {
                        setConnTesting(true);
                        setConnResults(null);
                        try {
                          const r = await fetch('/api/test-connection', { method: 'POST' });
                          const d = await r.json();
                          setConnResults(d.results || []);
                        } catch { setConnResults([]); }
                        finally { setConnTesting(false); }
                      }}
                      disabled={connTesting}
                      className="text-xs bg-blue-500 text-white px-3 py-1.5 rounded-lg hover:bg-blue-600 disabled:opacity-50"
                    >
                      {connTesting ? '测试中…' : '一键测试'}
                    </button>
                  </div>
                  <p className="text-[11px] text-blue-600">检测每个已配置 provider 的 API Key 是否可用</p>
                  {connResults && (
                    <div className="space-y-1 mt-1">
                      {connResults.length === 0 && <p className="text-[11px] text-blue-500">没有已配置的 provider</p>}
                      {connResults.map(r => (
                        <div key={r.provider} className="flex items-center gap-2 text-[11px]">
                          <span>{r.status === 'ok' ? '✅' : r.status === 'fail' ? '❌' : '⏭️'}</span>
                          <span className="font-mono font-bold text-pet-brown w-24 shrink-0">{r.provider}</span>
                          {r.status === 'ok' && <span className="text-green-700">{r.model} · {r.elapsed}ms</span>}
                          {r.status === 'fail' && <span className="text-red-600 truncate">{r.reason}</span>}
                          {r.status === 'skip' && <span className="text-gray-500">{r.reason}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              {/* 技能商店 */}
              <div className="healing-card p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <Package size={18} className="text-blue-500" />
                  <h2 className="font-bold text-pet-brown">技能商店</h2>
                </div>
                <div className="flex gap-2">
                  <input
                    value={skillSearch}
                    onChange={e => setSkillSearch(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSkillSearch()}
                    placeholder="搜索技能，按回车查询…"
                    className="flex-1 bg-pet-cream/60 rounded-xl border border-pet-pink/30 px-4 py-2 text-sm focus:ring-2 focus:ring-pet-orange/30 focus:outline-none"
                  />
                  <button onClick={handleSkillSearch} disabled={skillSearching} className="bg-pet-orange text-white rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50 hover:scale-105 transition-transform">
                    {skillSearching ? '…' : '搜索'}
                  </button>
                </div>
                {skillSearchResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs text-pet-brown/40 font-bold uppercase tracking-wide">搜索结果</div>
                    {skillSearchResults.map((s: any) => (
                      <div key={s.slug} className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-bold text-pet-brown">{s.name || s.slug}</div>
                          <div className="text-[11px] text-pet-brown/50 truncate">{s.description}</div>
                        </div>
                        <button onClick={() => handleSkillInstall(s.slug)} className="text-xs bg-pet-orange text-white px-3 py-1.5 rounded-xl font-bold hover:scale-105 transition-transform shrink-0">
                          安装
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {dashSkills.length === 0 && !dashLoading ? (
                  <p className="text-sm text-pet-brown/40">暂无已安装技能</p>
                ) : (
                  <div>
                    <div className="text-xs text-pet-brown/40 font-bold uppercase tracking-wide mb-2">已安装</div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {dashSkills.map((s: any) => (
                        <div key={s.slug || s.id} className="flex items-center gap-2 p-3 bg-pet-cream/60 rounded-xl">
                          <Package size={14} className="text-blue-400 shrink-0" />
                          <span className="text-xs font-medium text-pet-brown truncate">{s.name || s.slug}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : activeTab === 'hole' ? (
          /* Tree Hole Section */
          <section className="flex-1 flex flex-col p-6 md:p-12 overflow-y-auto pb-24 md:pb-12">
            <div className="max-w-2xl mx-auto w-full space-y-8">
              <div className="text-center space-y-2">
                <h1 className="text-4xl font-display font-bold text-pet-brown">{t('treeHoleTitle')}</h1>
                <p className="text-pet-brown/60">{t('treeHoleSubtitle')}</p>
              </div>

              <div className="healing-card p-6 space-y-4">
                <textarea 
                  value={holeContent}
                  onChange={(e) => setHoleContent(e.target.value)}
                  placeholder={t('holePlaceholder')}
                  className="w-full h-32 bg-pet-cream/50 rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm resize-none"
                />
                <div className="flex justify-end">
                  <button 
                    onClick={() => {
                      if (!holeContent.trim()) return;
                      socketRef.current?.emit('post_tree_hole', holeContent);
                      setHoleContent('');
                    }}
                    disabled={!holeContent.trim()}
                    className="bg-pet-brown text-white px-8 py-3 rounded-2xl font-bold pet-shadow hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                  >
                    {t('postHole')}
                  </button>
                </div>
              </div>

              <div className="space-y-6">
                {treeHolePosts.map((post) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    key={post.id} 
                    className="bg-white/40 rounded-[32px] p-8 space-y-6"
                  >
                    <div className="space-y-2">
                      <p className="text-pet-brown/80 italic">“{post.content}”</p>
                      <div className="text-[10px] text-pet-brown/30">{format(new Date(post.timestamp), 'yyyy-MM-dd HH:mm')}</div>
                    </div>

                    {post.replies.length > 0 && (
                      <div className="space-y-4 pt-4 border-t border-pet-pink/10">
                        {post.replies.map((reply, i) => (
                          <motion.div 
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            key={i} 
                            className="flex gap-3 bg-pet-orange/5 p-4 rounded-2xl"
                          >
                            <img src={reply.avatar} className="w-8 h-8 rounded-lg" referrerPolicy="no-referrer" />
                            <div>
                              <div className="text-[10px] font-bold text-pet-orange mb-1">{reply.author}</div>
                              <p className="text-xs text-pet-brown/70">{reply.content}</p>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                ))}
              </div>
            </div>
          </section>
        ) : activeTab === 'square' ? (
          /* 搭子广场 */
          <section className="flex-1 flex flex-col overflow-y-auto pb-24 md:pb-8">
            <header className="p-6 md:p-8 bg-white/50 pr-24 md:pr-40 flex items-center justify-between">
              <div>
                <h1 className="text-3xl md:text-4xl font-display font-bold text-pet-brown mb-1">{t('square')}</h1>
                <p className="text-sm text-pet-brown/60">找到你的学习搭子，一起成长 🐾</p>
              </div>
              <button
                onClick={() => setShowPostModal(true)}
                className="flex items-center gap-2 bg-pet-orange text-white px-4 py-2.5 rounded-2xl font-bold text-sm pet-shadow hover:scale-105 transition-transform"
              >
                <Plus size={18} />
                发帖
              </button>
            </header>
            <div className="p-6 md:p-8 max-w-2xl mx-auto w-full space-y-4">
              {posts.length === 0 ? (
                <div className="text-center py-20 text-pet-brown/40">
                  <Globe size={48} className="mx-auto mb-4 opacity-30" />
                  <p className="text-lg font-display">还没有帖子</p>
                  <p className="text-sm mt-1">来发第一帖吧！</p>
                </div>
              ) : (
                posts.map((post: any) => (
                  <div key={post.id} className="bg-white rounded-3xl p-5 pet-shadow space-y-3">
                    <div className="flex items-center gap-3">
                      <img src={post.avatar || `https://api.dicebear.com/7.x/adventurer/svg?seed=${post.author}`} className="w-10 h-10 rounded-full" />
                      <div>
                        <p className="font-bold text-pet-brown text-sm">{post.author}</p>
                        <p className="text-xs text-pet-brown/40">{post.createdAt ? new Date(post.createdAt).toLocaleString('zh-CN') : ''}</p>
                      </div>
                      {post.tag && (
                        <span className="ml-auto bg-pet-orange/10 text-pet-orange text-xs font-bold px-3 py-1 rounded-full">{post.tag}</span>
                      )}
                    </div>
                    <p className="text-pet-brown text-sm leading-relaxed">{post.content}</p>
                    <div className="flex items-center gap-4 pt-1">
                      <button className="flex items-center gap-1.5 text-xs text-pet-brown/40 hover:text-pet-orange transition-colors">
                        <Heart size={14} /> {post.likes ?? 0}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        ) : activeTab === 'manage' ? (
          /* Manage Panel */
          <section className="flex-1 flex flex-col overflow-y-auto pb-24 md:pb-8">
            <header className="p-6 md:p-8 bg-white/50 pr-24 md:pr-40">
              <h1 className="text-3xl md:text-4xl font-display font-bold text-pet-brown mb-1">管理</h1>
              <p className="text-sm text-pet-brown/60">管理 AI 可访问的文件路径，上传新文件到工作区</p>
            </header>

            <div className="p-6 md:p-8 space-y-8 max-w-3xl">
              {/* Allowed Paths */}
              <div className="bg-white rounded-3xl p-6 pet-shadow space-y-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-2xl bg-pet-orange/10 flex items-center justify-center">
                    <FolderPlus size={18} className="text-pet-orange" />
                  </div>
                  <div>
                    <h2 className="font-bold text-pet-brown">允许访问的路径</h2>
                    <p className="text-xs text-pet-brown/50">AI 只能读取这些目录下的文件</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <input
                    value={manageNewPath}
                    onChange={e => setManageNewPath(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddManagePath()}
                    placeholder="输入完整路径，如 /Users/xxx/Documents"
                    className="flex-1 bg-pet-cream rounded-2xl px-4 py-3 text-sm focus:ring-2 focus:ring-pet-orange/30 focus:outline-none font-mono"
                  />
                  <button
                    onClick={handleAddManagePath}
                    className="bg-pet-orange text-white px-5 py-3 rounded-2xl font-bold text-sm hover:opacity-90 transition-opacity"
                  >
                    添加
                  </button>
                </div>

                {managePathsLoading ? (
                  <div className="flex items-center gap-2 py-4 text-pet-brown/40 text-sm">
                    <div className="w-4 h-4 border-2 border-pet-orange/40 border-t-pet-orange rounded-full animate-spin" />
                    加载中…
                  </div>
                ) : managePaths.length === 0 ? (
                  <p className="text-pet-brown/30 text-sm py-4 text-center">暂无已添加的路径</p>
                ) : (
                  <div className="space-y-2">
                    {managePaths.map((p, i) => (
                      <div key={i} className="flex items-center gap-3 bg-pet-cream rounded-2xl px-4 py-3">
                        <FolderOpen size={16} className="text-pet-orange shrink-0" />
                        <span className="flex-1 text-sm font-mono text-pet-brown truncate">{p}</span>
                        <button
                          onClick={() => handleRemoveManagePath(p)}
                          className="text-pet-brown/30 hover:text-red-400 transition-colors"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Upload Files */}
              <div className="bg-white rounded-3xl p-6 pet-shadow space-y-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-9 h-9 rounded-2xl bg-purple-100 flex items-center justify-center">
                    <Upload size={18} className="text-purple-600" />
                  </div>
                  <div>
                    <h2 className="font-bold text-pet-brown">上传文件</h2>
                    <p className="text-xs text-pet-brown/50">文件将保存到 AI 工作区，可被直接引用</p>
                  </div>
                </div>

                <input
                  ref={manageUploadRef}
                  type="file"
                  className="hidden"
                  onChange={handleManageUpload}
                  accept=".pdf,.txt,.md,.docx,.doc,.csv,.json"
                />
                <button
                  onClick={() => manageUploadRef.current?.click()}
                  className="w-full border-2 border-dashed border-pet-pink/40 rounded-2xl py-8 flex flex-col items-center gap-3 text-pet-brown/50 hover:border-pet-orange/40 hover:text-pet-orange transition-colors"
                >
                  <Upload size={28} />
                  <span className="text-sm font-medium">点击选择文件上传</span>
                  <span className="text-xs">支持 PDF、Word、TXT、Markdown、CSV、JSON</span>
                </button>

                {manageUploadStatus && (
                  <div className={cn(
                    "text-sm px-4 py-3 rounded-2xl",
                    manageUploadStatus.startsWith('✓') ? "bg-emerald-50 text-emerald-700" :
                    manageUploadStatus.startsWith('✗') ? "bg-red-50 text-red-600" :
                    "bg-pet-cream text-pet-brown/60"
                  )}>
                    {manageUploadStatus}
                  </div>
                )}

                {/* File List */}
                {manageFilesLoading ? (
                  <div className="flex items-center gap-2 py-4 text-pet-brown/40 text-sm">
                    <div className="w-4 h-4 border-2 border-pet-orange/40 border-t-pet-orange rounded-full animate-spin" />
                    加载中…
                  </div>
                ) : manageFiles.length > 0 && (
                  <div className="space-y-2 pt-2">
                    <p className="text-xs font-bold text-pet-brown/40 uppercase tracking-wider">工作区文件</p>
                    <div className="divide-y divide-pet-pink/10 rounded-2xl border border-pet-pink/20 overflow-hidden">
                      {manageFiles.map((f, i) => (
                        <div key={i} className="flex items-center gap-3 px-4 py-3 hover:bg-pet-cream/40 transition-colors">
                          <FileText size={16} className="text-pet-brown/40 shrink-0" />
                          <span className="flex-1 text-sm text-pet-brown truncate">{f.name}</span>
                          <span className="text-xs text-pet-brown/30 shrink-0">
                            {f.size > 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)}MB` : `${Math.round(f.size / 1024)}KB`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden h-16 bg-white border-t border-pet-pink/30 flex items-center justify-around px-4 fixed bottom-0 left-0 right-0 z-40">
        <NavButton 
          active={activeTab === 'chat'} 
          onClick={() => { setActiveTab('chat'); setShowChatDetail(false); }}
          icon={<MessageCircle size={20} />}
          label={t('chat')}
        />
        <NavButton
          active={activeTab === 'dashboard'}
          onClick={() => { setActiveTab('dashboard'); setShowChatDetail(false); }}
          icon={<BarChart2 size={20} />}
          label="数据"
        />
        <NavButton 
          active={activeTab === 'pet'} 
          onClick={() => { setActiveTab('pet'); setShowChatDetail(false); }}
          icon={<Home size={20} />}
          label={t('pet')}
        />
        <NavButton 
          active={activeTab === 'study'} 
          onClick={() => { setActiveTab('study'); setShowChatDetail(false); }}
          icon={<Timer size={20} />}
          label={t('study')}
        />
        <NavButton 
          active={activeTab === 'hole'} 
          onClick={() => { setActiveTab('hole'); setShowChatDetail(false); }}
          icon={<Wind size={20} />}
          label={t('hole')}
        />
      </nav>

      <AnimatePresence>
        {showSetupWizard && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-pet-brown/30 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 24 }}
              className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[40px] bg-white pet-shadow"
            >
              <div className="grid max-h-[calc(100vh-2rem)] overflow-y-auto md:grid-cols-[0.92fr,1.08fr]">
                <div className="bg-pet-cream p-8 md:p-10 border-b md:border-b-0 md:border-r border-pet-pink/15">
                  <div className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-[11px] font-bold tracking-[0.2em] text-pet-brown/55 uppercase">
                    <Sparkles size={14} className="text-pet-orange" />
                    首次设置
                  </div>

                  <div className="mt-5">
                    <h2 className="text-3xl font-display font-bold text-pet-brown">先帮你把 AI 引擎接好</h2>
                    <p className="mt-3 text-sm leading-7 text-pet-brown/55">
                      后面换模型、换 Key 都直接在萌爪伴学里改，不用再碰命令行。
                    </p>
                  </div>

                  <div className="mt-8 space-y-3">
                    {SETUP_STEPS.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        onClick={() => setSetupStep(step.id)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left transition-all',
                          setupStep === step.id ? 'bg-white pet-shadow' : 'bg-white/55 hover:bg-white',
                        )}
                      >
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-pet-orange/12 text-pet-orange">
                          {setupStep > step.id ? <CheckCircle2 size={18} /> : <span className="text-sm font-bold">{step.id}</span>}
                        </div>
                        <div>
                          <div className="text-sm font-bold text-pet-brown">{step.label}</div>
                          <div className="text-xs text-pet-brown/45">
                            {step.id === 1 ? '先选一个最适合你的默认模型' : '再把对应的 API Key 接进来'}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="mt-8 rounded-[28px] bg-white p-5">
                    <div className="text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40">当前会保存到</div>
                    <div className="mt-2 text-sm font-semibold text-pet-brown">萌爪伴学自己的独立 OpenClaw 环境</div>
                    <p className="mt-2 text-xs leading-6 text-pet-brown/50">
                      不会改坏你电脑原本那套环境，后面发给别人也能沿用这一套流程。
                    </p>
                  </div>
                </div>

                <div className="p-8 md:p-10">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-[0.2em] text-pet-brown/35">
                        Step {setupStep} / {SETUP_STEPS.length}
                      </div>
                      <h3 className="mt-2 text-2xl font-display font-bold text-pet-brown">
                        {setupStep === 1
                          ? '先部署你的小龙虾引擎'
                          : setupStep === 2
                            ? '先选默认模型公司'
                            : setupStep === 3
                              ? '把 Key 接进来'
                              : '后台引擎已唤醒'}
                      </h3>
                    </div>
                    {setupState?.completed && (
                      <button
                        type="button"
                        onClick={() => setShowSetupWizard(false)}
                        className="rounded-2xl bg-pet-cream px-4 py-2 text-xs font-bold text-pet-brown/60 hover:bg-pet-cream/80"
                      >
                        先关掉
                      </button>
                    )}
                  </div>

                  {setupStep === 1 && (
                    <div className="mt-6 space-y-4">
                      <div className="rounded-[32px] bg-[#221C1A] p-6 text-[#F6EDE5] shadow-[0_18px_60px_rgba(34,28,26,0.22)]">
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#E7C9A8]/70">Local Deployment</div>
                            <div className="mt-2 text-lg font-bold">正在把 OpenClaw 部署到这个用户自己的本地环境里</div>
                          </div>
                          <div className={cn(
                            'rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]',
                            deploymentStatus?.status === 'ready' && 'bg-[#2C4A39] text-[#C5F0D4]',
                            deploymentStatus?.status === 'running' && 'bg-[#5A452E] text-[#F9DEB6]',
                            deploymentStatus?.status === 'error' && 'bg-[#5A2E2E] text-[#F3C5C5]',
                            (!deploymentStatus || deploymentStatus.status === 'idle') && 'bg-[#4A413B] text-[#EAD9C9]',
                          )}>
                            {deploymentStatus?.status === 'ready'
                              ? 'deployed'
                              : deploymentStatus?.status === 'running'
                                ? 'deploying'
                                : deploymentStatus?.status === 'error'
                                  ? 'failed'
                                  : 'waiting'}
                          </div>
                        </div>

                        <div className="mt-5 space-y-2 font-mono text-sm leading-7">
                          {(deploymentStatus?.logs?.length ? deploymentStatus.logs : ['等待部署日志...']).map((line) => (
                            <div key={line} className="break-all text-[#F6EDE5]/88">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="rounded-[28px] bg-pet-cream/70 p-5">
                          <div className="text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40">部署目标</div>
                          <p className="mt-2 text-sm leading-7 text-pet-brown/65">
                            这不是在复用你电脑原本那套 OpenClaw，而是在 PawPals 自己的数据目录里部署一套独立本地环境。
                          </p>
                        </div>
                        <div className="rounded-[28px] bg-pet-cream/70 p-5">
                          <div className="text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40">当前环境</div>
                          <div className="mt-2 space-y-2 text-sm leading-7 text-pet-brown/65">
                            <div>openclaw home: {deploymentStatus?.openClawHome || '等待生成...'}</div>
                            <div>app data: {deploymentStatus?.appDataDir || '等待生成...'}</div>
                            <div>bundled runtime: {deploymentStatus?.usingBundledRuntime ? 'yes' : 'no'}</div>
                          </div>
                        </div>
                      </div>

                      {deploymentStatus?.error && (
                        <div className="rounded-2xl bg-[#FFF1EC] px-4 py-3 text-sm text-[#A44A2F]">
                          {deploymentStatus.error}
                        </div>
                      )}
                    </div>
                  )}

                  {setupStep === 2 && (
                    <div className="mt-6 space-y-3">
                      {MODEL_COMPANIES.map((company) => {
                        const selected = selectedCompanyProvider === company.provider;
                        const configured = setupState?.providers?.[company.provider]?.apiKeyConfigured;
                        return (
                          <button
                            key={company.provider}
                            type="button"
                            onClick={() => {
                              setSelectedCompanyProvider(company.provider);
                              if (!company.custom) {
                                setSelectedSetupModel(company.models[0]?.model || '');
                              }
                              setSetupMessage(null);
                            }}
                            className={cn(
                              'w-full rounded-[28px] border p-5 text-left transition-all',
                              selected ? 'border-pet-orange bg-pet-orange/5 pet-shadow' : 'border-pet-pink/20 bg-pet-cream/45 hover:border-pet-orange/40 hover:bg-pet-orange/5',
                            )}
                          >
                            <div className="flex items-start gap-4">
                              <div className={cn(
                                'flex h-14 w-14 items-center justify-center rounded-3xl text-2xl',
                                selected ? 'bg-white' : 'bg-white/70',
                              )}>
                                {company.emoji}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="text-lg font-bold text-pet-brown">{company.company}</div>
                                  <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-pet-orange">
                                    {company.badge}
                                  </span>
                                  {configured && (
                                    <span className="rounded-full bg-pet-mint/15 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-pet-mint">
                                      已保存 Key
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 text-sm font-medium text-pet-brown/70">{company.subtitle}</div>
                                <p className="mt-2 text-sm leading-6 text-pet-brown/55">{company.description}</p>
                                <div className="mt-4 flex flex-wrap gap-2">
                                  {company.custom ? (
                                    <span className="rounded-full bg-white px-3 py-2 text-xs font-semibold text-pet-brown/55">
                                      高级用户可手动填写 provider / model / URL
                                    </span>
                                  ) : (
                                    company.models.map((item) => (
                                      <button
                                        key={`${company.provider}-${item.model}`}
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedCompanyProvider(company.provider);
                                          setSelectedSetupModel(item.model);
                                          setSetupMessage(null);
                                        }}
                                        className={cn(
                                          'rounded-full px-3 py-2 text-xs font-semibold transition-all',
                                          selected && selectedSetupModel === item.model
                                            ? 'bg-pet-orange text-white'
                                            : 'bg-white text-pet-brown/65 hover:bg-pet-orange/10',
                                        )}
                                      >
                                        {item.label}
                                      </button>
                                    ))
                                  )}
                                </div>
                              </div>
                              <div className="mt-1 text-pet-orange">
                                {selected ? <CheckCircle2 size={22} /> : <Circle size={22} />}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {setupStep === 3 && (
                    <div className="mt-6">
                      <div className="rounded-[32px] bg-pet-cream/60 p-6">
                        <div className="flex items-start gap-4">
                          <div className="flex h-14 w-14 items-center justify-center rounded-3xl bg-white text-2xl">
                            {selectedCompany.emoji}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-xl font-bold text-pet-brown">{selectedCompany.company}</div>
                              <span className="rounded-full bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-pet-orange">
                                {selectedCompany.custom ? '自定义接入' : '默认推荐'}
                              </span>
                            </div>
                            <div className="mt-2 text-sm font-medium text-pet-brown/70">
                              {selectedCompany.custom
                                ? '高级用户手动接入'
                                : (selectedCompany.models.find((item) => item.model === selectedSetupModel)?.label || selectedCompany.models[0]?.label)}
                            </div>
                            <p className="mt-2 text-sm leading-6 text-pet-brown/55">{selectedCompany.description}</p>
                            <div className="mt-4 flex flex-wrap gap-3">
                              {!selectedCompany.custom && (
                                <button
                                  type="button"
                                  onClick={() => window.open(selectedCompany.keyUrl, '_blank', 'noopener,noreferrer')}
                                  className="rounded-2xl bg-white px-4 py-3 text-sm font-bold text-pet-brown pet-shadow hover:scale-[1.02] transition-transform"
                                >
                                  {selectedCompany.keyLabel}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setSetupStep(1)}
                                className="rounded-2xl bg-white/70 px-4 py-3 text-sm font-bold text-pet-brown/60 hover:bg-white"
                              >
                                换一个模型
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      {!selectedCompany.custom && (
                        <div className="mt-5 flex flex-wrap gap-2">
                          {selectedCompany.models.map((item) => (
                            <button
                              key={`${selectedCompany.provider}-step2-${item.model}`}
                              type="button"
                              onClick={() => {
                                setSelectedSetupModel(item.model);
                                setSetupMessage(null);
                              }}
                              className={cn(
                                'rounded-full px-4 py-3 text-sm font-semibold transition-all',
                                selectedSetupModel === item.model
                                  ? 'bg-pet-orange text-white'
                                  : 'bg-pet-cream text-pet-brown/65 hover:bg-pet-orange/10',
                              )}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      )}

                      {selectedCompany.custom && (
                        <div className="mt-5 grid gap-3 md:grid-cols-2">
                          <input
                            value={customProviderKey}
                            onChange={(e) => setCustomProviderKey(e.target.value)}
                            placeholder="provider 名，例如 openrouter"
                            className="w-full rounded-[24px] bg-pet-cream px-5 py-4 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30"
                          />
                          <input
                            value={customModelName}
                            onChange={(e) => setCustomModelName(e.target.value)}
                            placeholder="模型名，例如 openai/gpt-4.1-mini"
                            className="w-full rounded-[24px] bg-pet-cream px-5 py-4 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30"
                          />
                          <div className="md:col-span-2">
                            <input
                              value={customBaseUrl}
                              onChange={(e) => setCustomBaseUrl(e.target.value)}
                              placeholder="base URL，例如 https://openrouter.ai/api/v1"
                              className="w-full rounded-[24px] bg-pet-cream px-5 py-4 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30"
                            />
                          </div>
                        </div>
                      )}

                      <div className="mt-5 space-y-3">
                        <label className="block text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40">
                          把 API Key 粘贴到这里
                        </label>
                        <textarea
                          rows={4}
                          value={setupApiKey}
                          onChange={(e) => {
                            setSetupApiKey(e.target.value);
                            setSetupMessage(null);
                          }}
                          placeholder={selectedCompany.placeholder}
                          className="w-full rounded-[28px] bg-pet-cream p-5 text-sm text-pet-brown border-none resize-none focus:ring-2 focus:ring-pet-orange/30"
                        />
                        <div className="flex items-start justify-between gap-4">
                          <p className="text-xs leading-6 text-pet-brown/45">
                            {hasSavedKeyForSelectedProvider
                              ? '这家公司之前已经保存过一把 key。不重填也能直接保存；重新粘贴会覆盖原来的。'
                              : '不会把你的 key 暴露到界面里，只会写进萌爪伴学自己的本地运行环境。'}
                          </p>
                          <button
                            type="button"
                            onClick={handleValidateSetupKey}
                            disabled={setupValidating}
                            className="shrink-0 rounded-2xl bg-white px-4 py-3 text-sm font-bold text-pet-orange pet-shadow hover:scale-[1.02] transition-transform disabled:opacity-50 disabled:scale-100"
                          >
                            {setupValidating ? '正在验证...' : '先试连一下'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {setupStep === 4 && (
                    <div className="mt-6 space-y-4">
                      <div className="rounded-[32px] bg-[#221C1A] p-6 text-[#F6EDE5] shadow-[0_18px_60px_rgba(34,28,26,0.22)]">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-xs font-bold uppercase tracking-[0.24em] text-[#E7C9A8]/70">Runtime Console</div>
                            <div className="mt-2 text-lg font-bold">🦞 OpenClaw 已在后台苏醒</div>
                          </div>
                          <div className={cn(
                            'rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]',
                            runtimeStatus?.gatewayReachable ? 'bg-[#2C4A39] text-[#C5F0D4]' : 'bg-[#5A2E2E] text-[#F3C5C5]',
                          )}>
                            {runtimeStatus?.gatewayReachable ? 'gateway online' : 'gateway offline'}
                          </div>
                        </div>

                        <div className="mt-5 space-y-2 font-mono text-sm leading-7">
                          {bootLogs.map((line) => (
                            <div key={line} className="break-all text-[#F6EDE5]/88">
                              {line}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-[28px] bg-pet-cream/70 p-5">
                        <div className="text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40">你现在看到的是</div>
                        <p className="mt-2 text-sm leading-7 text-pet-brown/65">
                          PawPals 自己的 Web UI channel 正在连一套独立的 OpenClaw gateway，不是直接复用你个人那套控制台页面。
                        </p>
                      </div>
                    </div>
                  )}

                  {setupMessage && (
                    <div className={cn(
                      'mt-5 rounded-2xl px-4 py-3 text-sm',
                      setupMessage.type === 'success' && 'bg-pet-mint/15 text-pet-brown',
                      setupMessage.type === 'error' && 'bg-[#FFF1EC] text-[#A44A2F]',
                      setupMessage.type === 'info' && 'bg-pet-cream text-pet-brown/70',
                    )}>
                      {setupMessage.text}
                    </div>
                  )}

                  <div className="mt-8 flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (setupStep === 1) {
                          setShowSetupWizard(Boolean(setupState?.completed));
                          return;
                        }
                        setSetupStep(setupStep - 1);
                      }}
                      className="rounded-2xl bg-pet-cream px-5 py-3 text-sm font-bold text-pet-brown/60 hover:bg-pet-cream/80"
                    >
                      {setupStep === 1 ? (setupState?.completed ? '先关闭' : '稍后再说') : '上一步'}
                    </button>

                    {setupStep === 1 && (
                      <button
                        type="button"
                        onClick={() => setSetupStep(2)}
                        disabled={!deploymentStatus?.deployed}
                        className="rounded-2xl bg-pet-orange px-5 py-3 text-sm font-bold text-white pet-shadow hover:scale-[1.02] transition-transform disabled:opacity-50 disabled:scale-100"
                      >
                        {deploymentStatus?.deployed ? '引擎已经部署好，继续' : '先等本地部署完成'}
                      </button>
                    )}
                    {setupStep === 2 && (
                      <button
                        type="button"
                        onClick={() => setSetupStep(3)}
                        className="rounded-2xl bg-pet-orange px-5 py-3 text-sm font-bold text-white pet-shadow hover:scale-[1.02] transition-transform"
                      >
                        用这个模型继续
                      </button>
                    )}
                    {setupStep === 3 && (
                      <button
                        type="button"
                        onClick={handleSaveSetup}
                        disabled={setupLoading}
                        className="rounded-2xl bg-pet-orange px-5 py-3 text-sm font-bold text-white pet-shadow hover:scale-[1.02] transition-transform disabled:opacity-50 disabled:scale-100"
                      >
                        {setupLoading ? '正在保存...' : '保存并开始使用'}
                      </button>
                    )}
                    {setupStep === 4 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowSetupWizard(false);
                          setActiveTab('chat');
                          handleSelectChat(buildChiefChat());
                          if (!petProfileConfigured) {
                            onboardingAfterWakeRef.current = true;
                          }
                          requestChiefWake();
                        }}
                        className="rounded-2xl bg-pet-orange px-5 py-3 text-sm font-bold text-white pet-shadow hover:scale-[1.02] transition-transform"
                      >
                        {petProfileConfigured ? '进入萌爪伴学' : '去创建首席伴学官'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPetProfileWizard && appStatus === 'main' && (
          <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/25 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0"
              onClick={() => setShowPetProfileWizard(false)}
            />
            <div className="relative z-[91] w-full flex items-center justify-center">
              {renderPetProfileCard()}
            </div>
          </div>
        )}
      </AnimatePresence>

      {/* 换模型弹框 */}
      <AnimatePresence>
        {showModelSwitch && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute inset-0 bg-pet-brown/30 backdrop-blur-md"
              onClick={() => setShowModelSwitch(false)}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 24 }}
              className="relative w-full max-w-lg bg-white rounded-[36px] pet-shadow p-8 overflow-y-auto max-h-[calc(100vh-2rem)]"
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-pet-brown/40 mb-1">
                    <Cpu size={12} className="text-pet-orange" />
                    换模型
                  </div>
                  <h2 className="text-2xl font-display font-bold text-pet-brown">切换 AI 引擎</h2>
                  {setupState?.primaryModel && (
                    <p className="text-xs text-pet-brown/45 mt-1">当前：{setupState.primaryModel}</p>
                  )}
                </div>
                <button onClick={() => setShowModelSwitch(false)} className="w-8 h-8 flex items-center justify-center rounded-full bg-pet-cream text-pet-brown/50 hover:bg-pet-pink/20">
                  <X size={16} />
                </button>
              </div>

              {/* Provider 选择 */}
              <div className="mb-5">
                <label className="block text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40 mb-3">选模型厂商</label>
                <div className="flex flex-wrap gap-2">
                  {MODEL_COMPANIES.map((c) => (
                    <button
                      key={c.provider}
                      type="button"
                      onClick={() => {
                        setSwitchProvider(c.provider);
                        setSwitchModel(c.models[0]?.model || '');
                        setSwitchMessage(null);
                      }}
                      className={cn(
                        'rounded-full px-4 py-2 text-sm font-semibold transition-all',
                        switchProvider === c.provider
                          ? 'bg-pet-orange text-white'
                          : 'bg-pet-cream text-pet-brown/65 hover:bg-pet-orange/10',
                      )}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* 模型选择 */}
              {switchProvider && (() => {
                const company = MODEL_COMPANIES.find(c => c.provider === switchProvider);
                if (!company) return null;
                if (company.custom) return (
                  <div className="mb-5 grid gap-3 md:grid-cols-2">
                    <input value={switchCustomProvider} onChange={e => setSwitchCustomProvider(e.target.value)}
                      placeholder="provider 名，例如 openrouter"
                      className="w-full rounded-[24px] bg-pet-cream px-5 py-3 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30" />
                    <input value={switchCustomModel} onChange={e => { setSwitchCustomModel(e.target.value); setSwitchModel(e.target.value); }}
                      placeholder="模型名，例如 gpt-4.1"
                      className="w-full rounded-[24px] bg-pet-cream px-5 py-3 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30" />
                    <div className="md:col-span-2">
                      <input value={switchBaseUrl} onChange={e => setSwitchBaseUrl(e.target.value)}
                        placeholder="base URL，例如 https://openrouter.ai/api/v1"
                        className="w-full rounded-[24px] bg-pet-cream px-5 py-3 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30" />
                    </div>
                  </div>
                );
                return (
                  <div className="mb-5">
                    <label className="block text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40 mb-3">选具体模型</label>
                    <div className="flex flex-wrap gap-2">
                      {company.models.map(item => (
                        <button key={item.model} type="button"
                          onClick={() => { setSwitchModel(item.model); setSwitchMessage(null); }}
                          className={cn(
                            'rounded-full px-4 py-2 text-sm font-semibold transition-all',
                            switchModel === item.model ? 'bg-pet-orange text-white' : 'bg-pet-cream text-pet-brown/65 hover:bg-pet-orange/10',
                          )}
                        >
                          {item.label}
                          {item.note && <span className="ml-1.5 text-[10px] opacity-60">{item.note}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* API Key */}
              <div className="mb-5">
                <label className="block text-xs font-bold uppercase tracking-[0.18em] text-pet-brown/40 mb-3">API Key（留空则保留原来的）</label>
                <input
                  type="password"
                  value={switchApiKey}
                  onChange={e => { setSwitchApiKey(e.target.value); setSwitchMessage(null); }}
                  placeholder="粘贴新 Key，或留空沿用已保存的"
                  className="w-full rounded-[24px] bg-pet-cream px-5 py-3 text-sm text-pet-brown border-none focus:ring-2 focus:ring-pet-orange/30"
                />
              </div>

              {switchMessage && (
                <div className={cn(
                  'mb-5 rounded-2xl px-4 py-3 text-sm',
                  switchMessage.type === 'success' ? 'bg-pet-mint/15 text-pet-brown' : 'bg-[#FFF1EC] text-[#A44A2F]',
                )}>
                  {switchMessage.text}
                </div>
              )}

              <div className="flex gap-3">
                <button type="button" onClick={() => setShowModelSwitch(false)}
                  className="rounded-2xl bg-pet-cream px-5 py-3 text-sm font-bold text-pet-brown/60 hover:bg-pet-cream/80">
                  取消
                </button>
                <button
                  type="button"
                  disabled={switchLoading || !switchProvider || !switchModel}
                  onClick={async () => {
                    const company = MODEL_COMPANIES.find(c => c.provider === switchProvider);
                    const finalProvider = company?.custom ? switchCustomProvider.trim() : switchProvider;
                    const finalModel = company?.custom ? switchCustomModel.trim() : switchModel;
                    const finalBaseUrl = company?.custom ? switchBaseUrl.trim() : '';
                    if (!finalProvider || !finalModel) {
                      setSwitchMessage({ type: 'error', text: '请先选择模型' });
                      return;
                    }
                    setSwitchLoading(true);
                    setSwitchMessage(null);
                    try {
                      const r = await fetch('/api/switch-model', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ provider: finalProvider, model: finalModel, apiKey: switchApiKey, baseUrl: finalBaseUrl }),
                      });
                      const data = await r.json();
                      if (data.ok) {
                        setSetupState(data.setup);
                        setSwitchMessage({ type: 'success', text: `已切换到 ${finalProvider}/${finalModel}，gateway 正在重启，约 10 秒后生效` });
                        setTimeout(() => setShowModelSwitch(false), 2500);
                      } else {
                        setSwitchMessage({ type: 'error', text: data.error || '切换失败' });
                      }
                    } catch {
                      setSwitchMessage({ type: 'error', text: '请求失败，请检查服务是否在运行' });
                    } finally {
                      setSwitchLoading(false);
                    }
                  }}
                  className="flex-1 flex items-center justify-center gap-2 rounded-2xl bg-pet-orange px-5 py-3 text-sm font-bold text-white pet-shadow hover:scale-[1.02] transition-transform disabled:opacity-50 disabled:scale-100"
                >
                  {switchLoading ? <><RefreshCw size={14} className="animate-spin" />切换中...</> : '保存并切换'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 招聘渠道配置弹框 */}
      <AnimatePresence>
        {showPlatformDialog && !showSetupWizard && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-white rounded-3xl p-6 w-full max-w-sm pet-shadow"
            >
              <div className="text-center mb-5">
                <div className="text-4xl mb-2">🐕</div>
                <h2 className="text-lg font-bold text-pet-brown">你一般用哪些招聘渠道？</h2>
                <p className="text-xs text-pet-brown/50 mt-1">助理们会帮你自动搜索和投递</p>
              </div>
              {[
                { id: 'boss',     label: 'Boss直聘',   emoji: '💼', desc: '支持自动投递' },
                { id: 'linkedin', label: 'LinkedIn',   emoji: '🔗', desc: '国际岗位' },
                { id: 'zhilian', label: '智联招聘',    emoji: '📋', desc: '综合平台' },
                { id: 'lagou',   label: '拉勾网',      emoji: '🎯', desc: '互联网垂直' },
                { id: 'campus',  label: '校园招聘',    emoji: '🎓', desc: '校招专场' },
              ].map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPlatforms(prev =>
                    prev.includes(p.id) ? prev.filter(x => x !== p.id) : [...prev, p.id]
                  )}
                  className={`w-full flex items-center gap-3 p-3 rounded-2xl mb-2 border-2 transition-all text-left
                    ${selectedPlatforms.includes(p.id)
                      ? 'border-pet-orange bg-pet-orange/10'
                      : 'border-transparent bg-pet-cream hover:bg-pet-orange/5'}`}
                >
                  <span className="text-xl">{p.emoji}</span>
                  <div className="flex-1">
                    <div className="font-semibold text-pet-brown text-sm">{p.label}</div>
                    <div className="text-xs text-pet-brown/50">{p.desc}</div>
                  </div>
                  {selectedPlatforms.includes(p.id) && <span className="text-pet-orange font-bold">✓</span>}
                </button>
              ))}
              <div className="flex gap-3 mt-4">
                <button
                  onClick={() => { platformsConfigured.current = true; localStorage.setItem('platformsConfigured', '1'); setShowPlatformDialog(false); }}
                  className="flex-1 py-2.5 rounded-2xl text-sm text-pet-brown/60 bg-pet-cream hover:bg-pet-cream/80"
                >
                  跳过
                </button>
                <button
                  onClick={handlePlatformConfirm}
                  disabled={selectedPlatforms.length === 0}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-semibold text-white bg-pet-orange hover:bg-pet-orange/90 disabled:opacity-40"
                >
                  {selectedPlatforms.includes('boss') ? '确认并登录 Boss' : '确认'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Post Modal */}
      <AnimatePresence>
        {showPostModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPostModal(false)}
              className="absolute inset-0 bg-pet-brown/20 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-[32px] p-8 pet-shadow"
            >
              <h2 className="text-2xl font-display font-bold text-pet-brown mb-6">{t('newPost')}</h2>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-xs font-bold text-pet-brown/40 uppercase tracking-wider mb-2">{t('selectTag')}</label>
                  <div className="flex flex-wrap gap-2">
                    {['求职', '考公', '考研', '生活'].map(tag => {
                      const tagMap: any = {
                        '求职': 'Jobs',
                        '考公': 'Civil',
                        '考研': 'Grad',
                        '生活': 'Life'
                      };
                      return (
                        <button 
                          key={tag}
                          onClick={() => setPostTag(tag as any)}
                          className={cn(
                            "px-4 py-2 rounded-xl text-sm transition-all",
                            postTag === tag ? "bg-pet-orange text-white" : "bg-pet-cream text-pet-brown/60 hover:bg-pet-pink/20"
                          )}
                        >
                          {lang === 'zh' ? tag : tagMap[tag]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-pet-brown/40 uppercase tracking-wider mb-2">{t('content')}</label>
                  <textarea 
                    value={postContent}
                    onChange={(e) => setPostContent(e.target.value)}
                    placeholder={t('postPlaceholder')}
                    className="w-full h-32 bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-sm resize-none"
                  />
                </div>

                <div className="flex gap-4">
                  <button 
                    onClick={() => setShowPostModal(false)}
                    className="flex-1 py-3 rounded-2xl font-bold text-pet-brown/40 hover:bg-pet-cream transition-colors"
                  >
                    {t('cancel')}
                  </button>
                  <button 
                    onClick={handleCreatePost}
                    disabled={!postContent.trim()}
                    className="flex-1 py-3 bg-pet-orange text-white rounded-2xl font-bold pet-shadow hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                  >
                    {t('publish')}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Notifications Popover */}
      <AnimatePresence>
        {showNotificationsPopover && (
          <div className="fixed inset-0 z-[100] flex items-start justify-end p-4 pointer-events-none">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowNotificationsPopover(false)}
              className="absolute inset-0 bg-transparent pointer-events-auto"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20, x: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0, x: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20, x: 20 }}
              className="relative w-full max-w-sm bg-white rounded-3xl pet-shadow overflow-hidden pointer-events-auto mt-12 mr-4 border border-pet-pink/20"
            >
              <div className="p-4 border-b border-pet-pink/10 flex justify-between items-center bg-pet-cream/30">
                <h3 className="font-bold text-pet-brown">消息通知</h3>
                <button 
                  onClick={() => {
                    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
                    setShowNotificationsPopover(false);
                  }}
                  className="text-[10px] font-bold text-pet-orange hover:underline"
                >
                  全部标记为已读
                </button>
              </div>
              <div className="max-h-[400px] overflow-y-auto p-2 space-y-2">
                {notifications.length > 0 ? (
                  notifications.map(notif => (
                    <div 
                      key={notif.id}
                      onClick={() => {
                        if (notif.type === 'system') {
                          handleSelectChat(buildChiefChat());
                          setShowNotificationsPopover(false);
                          setActiveTab('chat');
                        }
                        setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, read: true } : n));
                      }}
                      className={cn(
                        "p-3 rounded-2xl border transition-all flex gap-3",
                        notif.read ? "bg-white/40 border-transparent" : "bg-pet-orange/5 border-pet-orange/10",
                        notif.type === 'system' && "cursor-pointer hover:bg-pet-orange/10"
                      )}
                    >
                      <div className={cn(
                        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                        notif.type === 'achievement' ? "bg-pet-orange/10 text-pet-orange" :
                        notif.type === 'friendship' ? "bg-pet-mint/10 text-pet-mint" :
                        "bg-pet-pink/10 text-pet-pink"
                      )}>
                        {notif.type === 'achievement' ? <Trophy size={16} /> :
                         notif.type === 'friendship' ? <Users size={16} /> :
                         <Bell size={16} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start gap-2">
                          <h4 className="text-xs font-bold text-pet-brown truncate">{notif.title}</h4>
                          <span className="text-[8px] text-pet-brown/40 shrink-0">{format(new Date(notif.timestamp), 'HH:mm')}</span>
                        </div>
                        <p className="text-[10px] text-pet-brown/60 mt-0.5 line-clamp-2">{notif.content}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-8 text-center text-pet-brown/40 text-xs">暂无新通知</div>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* User Settings Modal */}
      <AnimatePresence>
        {showUserSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowUserSettings(false)}
              className="absolute inset-0 bg-pet-brown/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="relative w-full max-w-md bg-white rounded-[40px] overflow-hidden pet-shadow"
            >
              <div className="p-8 space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-display font-bold text-pet-brown">个人设置</h2>
                  <button onClick={() => setShowUserSettings(false)} className="text-pet-brown/40 hover:text-pet-brown">
                    <Plus className="rotate-45" />
                  </button>
                </div>

                <div className="flex flex-col items-center gap-4">
                  <div 
                    className="relative group cursor-pointer"
                    onClick={() => {
                      const newSeed = Math.random().toString(36).substring(7);
                      setUserProfile(prev => ({ ...prev, avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${newSeed}` }));
                    }}
                  >
                    <img 
                      src={userProfile.avatar} 
                      alt="User Avatar" 
                      className="w-24 h-24 rounded-full bg-pet-cream p-1 border-2 border-pet-orange object-cover"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/40 rounded-full opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                      <Dice5 className="text-white" />
                    </div>
                  </div>
                  <p className="text-[10px] text-pet-brown/40 font-bold uppercase tracking-widest">点击随机更换头像</p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-pet-brown/40 uppercase tracking-widest">用户昵称</label>
                    <input 
                      type="text" 
                      value={userProfile.name}
                      onChange={(e) => setUserProfile(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-pet-brown font-medium"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-pet-brown/40 uppercase tracking-widest">个性签名</label>
                    <textarea 
                      value={userProfile.signature}
                      onChange={(e) => setUserProfile(prev => ({ ...prev, signature: e.target.value }))}
                      rows={2}
                      className="w-full bg-pet-cream rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-pet-brown font-medium resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-pet-brown/40 uppercase tracking-widest">电子邮箱</label>
                    <input 
                      type="email" 
                      value={userProfile.email}
                      disabled
                      className="w-full bg-pet-cream/50 rounded-2xl p-4 border-none text-pet-brown/40 font-medium cursor-not-allowed"
                    />
                  </div>
                  <div className="rounded-3xl bg-pet-cream/70 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-xs font-bold text-pet-brown/40 uppercase tracking-widest">AI 能力设置</div>
                        <p className="mt-2 text-sm leading-6 text-pet-brown/60">
                          默认模型、API Key 这些都可以直接在这里重新配置，不用再手动输命令。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setShowUserSettings(false);
                          openSetupWizard();
                        }}
                        className="shrink-0 rounded-2xl bg-white px-4 py-3 text-xs font-bold text-pet-orange pet-shadow hover:scale-[1.02] transition-transform"
                      >
                        重新配置
                      </button>
                    </div>
                  </div>
                  <div className="pt-4">
                    <button 
                      onClick={() => setShowUserSettings(false)}
                      className="w-full bg-pet-orange text-white py-4 rounded-2xl font-bold pet-shadow hover:scale-[1.02] transition-transform"
                    >
                      保存修改
                    </button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Pet Settings Modal */}
      <AnimatePresence>
        {showPetSettings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowPetSettings(false)}
              className="absolute inset-0 bg-pet-brown/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="relative w-full max-w-md bg-pet-cream rounded-[40px] overflow-hidden pet-shadow"
            >
              <div className="p-8 space-y-6">
                <div className="flex justify-between items-center">
                  <h2 className="text-2xl font-display font-bold text-pet-brown">首席官设置</h2>
                  <button onClick={() => setShowPetSettings(false)} className="text-pet-brown/40 hover:text-pet-brown">
                    <Plus className="rotate-45" />
                  </button>
                </div>

                <div className="flex flex-col items-center gap-4">
                  <div className="relative group">
                    <img 
                      src={pet.avatar} 
                      alt="Avatar" 
                      className="w-24 h-24 rounded-3xl bg-white p-1 pet-shadow object-cover"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute inset-0 bg-black/40 rounded-3xl opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity cursor-pointer">
                      <Camera className="text-white" />
                    </div>
                  </div>
                  <p className="text-[10px] text-pet-brown/40 font-bold uppercase tracking-widest">点击更换首席官形象</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">首席官昵称</label>
                    <input 
                      type="text" 
                      value={pet.name}
                      onChange={(e) => setPet(prev => ({ ...prev, name: e.target.value }))}
                      className="w-full bg-white rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-pet-brown font-bold"
                      placeholder="给你的首席官起个名字..."
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-pet-brown/60 uppercase tracking-wider block mb-2 px-1">首席官人格/设定</label>
                    <textarea 
                      value={pet.personality}
                      onChange={(e) => setPet(prev => ({ ...prev, personality: e.target.value }))}
                      rows={3}
                      className="w-full bg-white rounded-2xl p-4 border-none focus:ring-2 focus:ring-pet-orange/30 text-pet-brown text-sm resize-none"
                      placeholder="描述一下它的人格，它会以这种口吻指导你..."
                    />
                  </div>
                </div>

                <button 
                  onClick={() => setShowPetSettings(false)}
                  className="w-full bg-pet-orange text-white py-4 rounded-2xl font-bold pet-shadow hover:scale-[1.02] transition-transform flex items-center justify-center gap-2"
                >
                  <Sparkles size={20} />
                  保存并同步
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Bot Friendship Notification */}
      <AnimatePresence>
        {botNotification && (
          <motion.div 
            initial={{ opacity: 0, y: 100, x: '-50%' }}
            animate={{ opacity: 1, y: -20, x: '-50%' }}
            exit={{ opacity: 0, y: 100, x: '-50%' }}
            className="fixed bottom-20 md:bottom-8 left-1/2 z-50 w-full max-w-sm px-4"
          >
            <div className="bg-pet-brown text-white p-4 rounded-2xl pet-shadow flex items-center gap-4 border-2 border-pet-orange">
              <div className="w-12 h-12 bg-white rounded-xl flex items-center justify-center text-2xl">
                🤝
              </div>
              <div className="flex-1">
                <div className="text-xs font-bold text-pet-orange uppercase tracking-wider mb-1">社交动态</div>
                <p className="text-xs leading-relaxed opacity-90">{botNotification.message}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Study Complete Modal / Poster */}
      <AnimatePresence>
        {showStudyCompleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowStudyCompleteModal(false)}
              className="absolute inset-0 bg-pet-brown/40 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 40 }}
              className="relative w-full max-w-md overflow-hidden rounded-[40px] pet-shadow"
            >
              {/* Poster Content */}
              <div className="bg-gradient-to-b from-pet-orange/20 to-white p-8 text-center space-y-6">
                <div className="flex justify-center">
                  <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center pet-shadow">
                    <Trophy className="text-pet-orange" size={40} />
                  </div>
                </div>
                
                <div>
                  <h2 className="text-2xl font-display font-bold text-pet-brown">自习圆满完成！</h2>
                  <p className="text-pet-brown/60 text-sm mt-1">你和 {pet.name} 又共同进步了一点点</p>
                </div>

                <div className="bg-white/60 rounded-3xl p-6 space-y-4">
                  <div className="flex justify-around items-center">
                    <div className="text-center">
                      <div className="text-3xl font-display font-bold text-pet-orange">{lastStudyDuration}</div>
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase tracking-wider">专注分钟</div>
                    </div>
                    <div className="w-px h-8 bg-pet-brown/10" />
                    <div className="text-center">
                      <div className="text-3xl font-display font-bold text-pet-mint">Lv.{pet.level}</div>
                      <div className="text-[10px] font-bold text-pet-brown/40 uppercase tracking-wider">宠物等级</div>
                    </div>
                  </div>
                  
                  <div className="flex items-center justify-center gap-4 py-2">
                    <span className="text-4xl animate-bounce">
                      {pet.type === 'cat' ? '🐈' : pet.type === 'dog' ? '🐕' : '🐇'}
                    </span>
                    <div className="text-left">
                      <div className="text-xs font-bold text-pet-brown">{pet.name} 觉得很赞！</div>
                      <div className="text-[10px] text-pet-brown/40">经验值 +20 | 能量 +10</div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <button 
                    onClick={handleShareStudyPoster}
                    className="w-full bg-pet-orange text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-2 pet-shadow hover:scale-[1.02] transition-transform"
                  >
                    <Share2 size={20} />
                    晒到广场
                  </button>
                  <div className="flex gap-3">
                    <button className="flex-1 bg-white text-pet-brown/60 py-3 rounded-2xl font-bold text-sm flex items-center justify-center gap-2 hover:bg-pet-cream transition-colors">
                      <Download size={18} />
                      保存海报
                    </button>
                    <button 
                      onClick={() => setShowStudyCompleteModal(false)}
                      className="flex-1 bg-white text-pet-brown/60 py-3 rounded-2xl font-bold text-sm hover:bg-pet-cream transition-colors"
                    >
                      下次一定
                    </button>
                  </div>
                </div>
              </div>
              
              {/* Decorative Elements */}
              <div className="absolute top-0 left-0 w-full h-2 bg-pet-orange" />
              <div className="absolute -top-12 -right-12 w-32 h-32 bg-pet-orange/10 rounded-full blur-3xl" />
              <div className="absolute -bottom-12 -left-12 w-32 h-32 bg-pet-mint/10 rounded-full blur-3xl" />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 group transition-all",
        active ? "text-pet-orange" : "text-pet-brown/40 hover:text-pet-brown"
      )}
    >
      <div className={cn(
        "p-3 rounded-2xl transition-all",
        active ? "bg-pet-orange/10" : "group-hover:bg-pet-cream"
      )}>
        {icon}
      </div>
      <span className="text-[10px] font-bold">{label}</span>
    </button>
  );
}

function ChatListItem({ item, active, onClick }: { item: ChatGroup, active: boolean, onClick: () => void, key?: string }) {
  return (
    <motion.button 
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={cn(
        "w-full p-3 rounded-2xl flex items-center gap-3 transition-all text-left",
        active ? "bg-white pet-shadow" : "hover:bg-white/40"
      )}
    >
      <div className="w-12 h-12 bg-pet-cream rounded-xl flex items-center justify-center text-2xl group-hover:rotate-12 transition-transform">
        {item.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center mb-0.5">
          <h3 className="font-bold text-pet-brown text-sm truncate">{item.name}</h3>
          <span className="text-[9px] text-pet-brown/30">12:45</span>
        </div>
        <p className="text-xs text-pet-brown/40 truncate">{item.description}</p>
      </div>
    </motion.button>
  );
}
