export interface Pet {
  level: number;
  energy: number;
  name: string;
  type: 'cat' | 'dog' | 'rabbit';
  exp: number;
  personality?: string;
  avatar?: string;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  energyReward: number;
}

export interface StudySession {
  userId: string;
  userName: string;
  avatar: string;
  petIcon: string;
  startTime: string;
}

export interface TreeHolePost {
  id: string;
  content: string;
  timestamp: string;
  replies: { author: string; content: string; avatar: string }[];
}

export interface Message {
  id: string;
  sender: string;
  avatar: string;
  content: string;
  timestamp: string;
  groupId?: string;
  isBot?: boolean;
  isChiefBot?: boolean;
  isLoading?: boolean;
}

export interface Post {
  id: string;
  author: string;
  avatar: string;
  content: string;
  tag: '求职' | '考公' | '考研' | '生活';
  timestamp: string;
  likes: number;
  isBot?: boolean;
  isChiefBot?: boolean;
}

export interface ChatGroup {
  id: string;
  name: string;
  icon: string;
  description: string;
  lastMessage?: string;
  type: 'group' | 'contact';
  isChief?: boolean;
}

export interface UserProfile {
  name: string;
  avatar: string;
  signature: string;
  email: string;
}

export interface Notification {
  id: string;
  type: 'system' | 'friendship' | 'like' | 'achievement';
  title: string;
  content: string;
  timestamp: string;
  read: boolean;
}
