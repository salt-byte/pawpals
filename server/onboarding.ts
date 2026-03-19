export type OnboardingStep =
  | "target_role"
  | "market"
  | "job_type_time"
  | "target_city"
  | "role_scope"
  | "company_preference"
  | "traits"
  | "skills";

export type OnboardingState = {
  phase: "resume_collection" | "profile_collection" | "professional_positioning" | "resume_diagnosis" | "resume_review" | "search_strategy" | "first_job_search" | "first_application" | "completed";
  currentStep: OnboardingStep | null;
  completed: boolean;
  resumeUploaded: boolean;
  transitionInFlight: boolean;
  lastError: string;
  slots: {
    targetRole: string;
    market: string;
    jobType: string;
    timeRange: string;
    returnOfferPreference: string;
    targetCity: string;
    roleScope: string;
    companyPreference: string;
    traits: string;
    skills: string[];
    inferredRoles: string[];
  };
  searchStrategy: {
    channels: string[];
    priorities: string[];
    confirmed: boolean;
  };
};

export type OnboardingSlotPatch = Partial<OnboardingState["slots"]>;

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "target_role",
  "market",
  "job_type_time",
  "target_city",
  "role_scope",
  "company_preference",
  "traits",
  "skills",
];

export function createDefaultOnboardingState(): OnboardingState {
  return {
    phase: "resume_collection",
    currentStep: "target_role",
    completed: false,
    resumeUploaded: false,
    transitionInFlight: false,
    lastError: "",
    slots: {
      targetRole: "",
      market: "",
      jobType: "",
      timeRange: "",
      returnOfferPreference: "",
      targetCity: "",
      roleScope: "",
      companyPreference: "",
      traits: "",
      skills: [],
      inferredRoles: [],
    },
    searchStrategy: {
      channels: [],
      priorities: [],
      confirmed: false,
    },
  };
}

export function normalizeSkills(text: string) {
  return Array.from(new Set(
    text
      .split(/[\n,，、/|·]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => item.length <= 24)
  )).slice(0, 10);
}

export function getNextOnboardingStep(state: OnboardingState): OnboardingStep | null {
  const missing = ONBOARDING_STEPS.find((step) => {
    if (step === "target_role") return !state.slots.targetRole;
    if (step === "market") return !state.slots.market;
    if (step === "job_type_time") return !state.slots.jobType || !state.slots.timeRange;
    if (step === "target_city") return !state.slots.targetCity;
    if (step === "role_scope") return !state.slots.roleScope;
    if (step === "company_preference") return !state.slots.companyPreference;
    if (step === "traits") return !state.slots.traits;
    if (step === "skills") return state.slots.skills.length === 0;
    return false;
  });
  return missing || null;
}

export function inferTargetRoles(targetRole: string, roleScope: string): string[] {
  const seed = targetRole.toLowerCase();
  const related = /相关|都可以|也可以|不限|拓展/.test(roleScope);
  if (/ai\s*pm|产品/.test(seed)) {
    return related
      ? ["AI Product Manager", "AI Strategy", "Technical PM", "Founder's Associate"]
      : ["AI Product Manager"];
  }
  if (/sde|工程|开发|后端|前端|full\s*stack|软件/.test(seed)) {
    return related
      ? ["Software Engineer", "Applied AI Engineer", "ML Engineer", "Forward Deployed Engineer"]
      : ["Software Engineer"];
  }
  if (/数据|分析/.test(seed)) {
    return related
      ? ["Data Analyst", "Product Analyst", "Business Analyst", "AI Ops Analyst"]
      : ["Data Analyst"];
  }
  return related ? [targetRole, `${targetRole}相关方向`] : [targetRole];
}

export function renderProfileMarkdown(state: OnboardingState) {
  const roles = state.slots.inferredRoles.length > 0 ? state.slots.inferredRoles : [state.slots.targetRole].filter(Boolean);
  return `# 用户档案

方向: ${state.slots.targetRole}
类型: ${state.slots.jobType}
市场: ${state.slots.market}
时间: ${state.slots.timeRange}
转正偏好: ${state.slots.returnOfferPreference || "未说明"}
城市: ${state.slots.targetCity}
范围: ${state.slots.roleScope}
公司偏好: ${state.slots.companyPreference}
个人特质: ${state.slots.traits}
搜索渠道: ${state.searchStrategy.channels.join(" / ") || "未确认"}
搜索优先级: ${state.searchStrategy.priorities.join(" > ") || "未确认"}

## 推断可关注岗位
${roles.map((role) => `- ${role}`).join("\n")}

## 技能
${state.slots.skills.map((skill) => `- ${skill}`).join("\n")}
`;
}

export function applyOnboardingSlotPatch(state: OnboardingState, patch: OnboardingSlotPatch) {
  const nextSlots = { ...state.slots };
  if (patch.targetRole) nextSlots.targetRole = patch.targetRole;
  if (patch.market) nextSlots.market = patch.market;
  if (patch.jobType) nextSlots.jobType = patch.jobType;
  if (patch.timeRange) nextSlots.timeRange = patch.timeRange;
  if (patch.returnOfferPreference) nextSlots.returnOfferPreference = patch.returnOfferPreference;
  if (patch.targetCity) nextSlots.targetCity = patch.targetCity;
  if (patch.roleScope) nextSlots.roleScope = patch.roleScope;
  if (patch.companyPreference) nextSlots.companyPreference = patch.companyPreference;
  if (patch.traits) nextSlots.traits = patch.traits;
  if (patch.skills && patch.skills.length > 0) nextSlots.skills = normalizeSkills(patch.skills.join("、"));
  if (patch.inferredRoles && patch.inferredRoles.length > 0) nextSlots.inferredRoles = patch.inferredRoles;
  if (nextSlots.targetRole) nextSlots.inferredRoles = inferTargetRoles(nextSlots.targetRole, nextSlots.roleScope);
  state.slots = nextSlots;
}

export function clearOnboardingStepValue(state: OnboardingState, step: OnboardingStep) {
  if (step === "target_role") {
    state.slots.targetRole = "";
    state.slots.inferredRoles = [];
    return;
  }
  if (step === "market") {
    state.slots.market = "";
    return;
  }
  if (step === "job_type_time") {
    state.slots.jobType = "";
    state.slots.timeRange = "";
    state.slots.returnOfferPreference = "";
    return;
  }
  if (step === "target_city") {
    state.slots.targetCity = "";
    return;
  }
  if (step === "role_scope") {
    state.slots.roleScope = "";
    return;
  }
  if (step === "company_preference") {
    state.slots.companyPreference = "";
    return;
  }
  if (step === "traits") {
    state.slots.traits = "";
    return;
  }
  state.slots.skills = [];
}

export function previousOnboardingStep(step: OnboardingStep | null): OnboardingStep | null {
  if (!step) return null;
  const index = ONBOARDING_STEPS.indexOf(step);
  if (index <= 0) return null;
  return ONBOARDING_STEPS[index - 1] || null;
}
