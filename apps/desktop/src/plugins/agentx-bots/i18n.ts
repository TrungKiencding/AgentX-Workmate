/**
 * Bot Mode copy, registered under the plugin id via ctx.i18n.register — never
 * touching core locale files. `useBots()` binds the message SHAPE to the
 * plugin translator so components read typed `b.create` / `b.next(when)`.
 *
 * Voice: everyday words for people who don't think in profiles, cron or
 * prompts — "trợ lý", "lịch tự động", "hướng dẫn riêng".
 */

import { type PluginLocaleBundles, type PluginTranslate, usePluginI18n } from '@agentx/plugin-sdk'
import { useMemo } from 'react'

export type TemplateId = 'research' | 'writer' | 'secretary' | 'analyst' | 'translator'

type Template = { title: string; description: string }

type BotsMessages = {
  nav: string
  work: string
  workspaceNavigation: string
  pageTitle: string
  pageDescription: string
  search: string
  create: string
  primaryName: string
  primaryRole: string
  sectionActive: string
  sectionPinned: string
  sectionBots: string
  noMessages: string
  fromBot: (handle: string) => string
  unread: string
  working: string
  noMatch: (query: string) => string
  loading: string
  loadError: string
  waitingGateway: string
  retry: string
  staleNotice: string
  onboardTitle: string
  onboardBody: string
  // detail
  message: string
  edit: string
  moreActions: string
  pin: string
  unpin: string
  moveToGroup: string
  changeGroup: (group: string) => string
  duplicate: string
  newChatWith: string
  delete: string
  lastActive: (when: string) => string
  neverActive: string
  modelDefault: string
  skillCount: (n: number) => string
  noDescription: string
  mentionTip: (handle: string) => string
  // routines
  routinesTitle: string
  routinesDescription: string
  addRoutine: string
  routinesEmpty: string
  routinesLoadError: string
  routinesStale: string
  nextRun: (when: string) => string
  paused: string
  lastFailed: string
  /** Why the last run failed, by cron.scheduler's failure kind. */
  failure: Record<string, string>
  pauseRoutine: string
  resumeRoutine: string
  deleteRoutine: string
  deleteRoutineTitle: (title: string) => string
  deleteRoutineBody: string
  routineUpdateFailed: string
  routineUntitled: string
  routineRanTitle: (task: string) => string
  routineRanBody: (assistant: string) => string
  routineFailedTitle: (task: string) => string
  routineRanView: string
  // conversations
  chatsTitle: string
  chatsDescription: string
  mainChat: string
  untitledChat: string
  chatsEmpty: string
  mainChatEmpty: string
  runsTitle: string
  runsDescription: string
  showAllChats: (n: number) => string
  showFewerChats: string
  openFailed: string
  // groups
  groupRoom: string
  groupRoomTitle: (group: string) => string
  groupMembers: (n: number) => string
  groupNeedsYou: string
  groupTooFew: string
  groupTooMany: (max: number, names: string) => string
  groupComposer: (group: string) => string
  groupSend: string
  groupWorking: string
  groupSpeaking: (name: string) => string
  groupEmptyTitle: (group: string) => string
  groupEmpty: string
  groupStarters: { plan: string; ideas: string; today: string }
  groupMention: (name: string) => string
  groupOutOfRoom: (name: string) => string
  groupEveryone: string
  groupMentionList: string
  groupAttach: string
  groupAttachRemove: (name: string) => string
  groupAttachTooLarge: (name: string, mb: number) => string
  groupAttachFailed: (name: string) => string
  groupDropHint: string
  groupStop: string
  groupStopped: string
  groupTurnFailed: (name: string) => string
  groupTurnTimedOut: (name: string) => string
  groupElapsed: (seconds: number) => string
  groupYou: string
  groupMemberGone: (name: string) => string
  recentChatsTitle: string
  recentChatsDescription: string
  groupApprovalTitle: (name: string) => string
  groupApprovalAllow: string
  groupApprovalDeny: string
  you: string
  clearRoom: string
  back: string
  // create / edit
  createTitle: string
  createDescription: string
  editTitle: string
  editDescription: (name: string) => string
  tabProfile: string
  tabBehavior: string
  tabSkills: string
  templates: string
  template: Record<TemplateId, Template>
  nameLabel: string
  namePlaceholder: string
  handleHint: (handle: string) => string
  descLabel: string
  descPlaceholder: string
  avatarLabel: string
  shapesLabel: string
  colorsLabel: string
  uploadImage: string
  generateImage: string
  generating: string
  generateUnavailable: string
  generateFailed: string
  useShape: string
  imageTooLarge: string
  advanced: string
  handleLabel: string
  handleHelp: string
  handleTaken: (handle: string) => string
  handleInvalid: string
  cloneLabel: string
  cloneFresh: string
  cloneFrom: (name: string) => string
  modelLabel: string
  modelHelp: string
  modelInherit: string
  modelLoading: string
  instructionsLabel: string
  instructionsHelp: string
  instructionsPlaceholder: string
  shareAuth: string
  shareAuthHelp: string
  skillsHelp: string
  skillsFilter: string
  skillsNone: string
  toolsLabel: string
  toolsHelp: string
  capsLoadError: string
  cancel: string
  save: string
  saving: string
  createAction: string
  creating: string
  created: (name: string) => string
  saved: (name: string) => string
  savedLocally: string
  partialSave: (sections: string) => string
  createFailed: string
  // delete / group / duplicate
  deleteTitle: (name: string) => string
  deleteBody: string
  deleteConfirm: string
  deleting: string
  deleted: (name: string) => string
  groupDialogTitle: string
  groupDialogDescription: string
  groupNewPlaceholder: string
  groupCreate: string
  groupRemove: (group: string) => string
  movedToGroup: (name: string, group: string) => string
  removedFromGroup: (name: string) => string
  duplicating: (name: string) => string
  duplicated: (name: string) => string
  duplicateFailed: string
  copySuffix: string
  // schedules
  routineDialogTitle: string
  routineDialogDescription: (name: string) => string
  routineNameLabel: string
  routineNamePlaceholder: string
  routineTaskLabel: string
  routineTaskPlaceholder: string
  whenLabel: string
  freq: Record<'advanced' | 'daily' | 'hourly' | 'interval' | 'monthly' | 'once' | 'weekdays' | 'weekly', string>
  weekday: Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', string>
  unit: Record<'d' | 'h' | 'm', string>
  atTime: string
  onDay: string
  inLabel: string
  everyLabel: string
  advancedSchedulePlaceholder: string
  stopAfter: string
  stopAfterHelp: string
  scheduleCreate: string
  scheduling: string
  routineCreated: (title: string) => string
  routineInvalid: string
  // schedule descriptions
  sDaily: (time: string) => string
  sWeekdays: (time: string) => string
  sWeekly: (day: string, time: string) => string
  sMonthly: (day: string, time: string) => string
  sEveryMinutes: (n: number) => string
  sEveryHours: (n: number) => string
  sEveryDays: (n: number) => string
  sHourly: string
  sOnceIn: (after: string) => string
  sOnceAt: (when: string) => string
  sRaw: (schedule: string) => string
  sTimes: (n: number) => string
  // composer / palette
  neverResetTitle: string
  neverResetBody: string
  paletteOpen: string
  paletteNew: string
}

const en: BotsMessages = {
  nav: 'Assistants',
  work: 'Work',
  workspaceNavigation: 'Work and assistants',
  pageTitle: 'Assistants',
  pageDescription:
    'Each assistant has its own name, memory and conversation. Hand off work, schedule it, or let them work together.',
  search: 'Search assistants',
  create: 'New assistant',
  primaryName: 'AgentX',
  primaryRole: 'Main assistant',
  sectionActive: 'Working now',
  sectionPinned: 'Pinned',
  sectionBots: 'Assistants',
  noMessages: 'No messages yet',
  fromBot: handle => `From @${handle}`,
  unread: 'New activity',
  working: 'Working',
  noMatch: query => `No assistant matches “${query}”.`,
  loading: 'Loading assistants…',
  loadError: 'Couldn’t load your assistants.',
  waitingGateway: 'Waiting for AgentX to connect…',
  retry: 'Try again',
  staleNotice: 'Couldn’t refresh — showing the last list.',
  onboardTitle: 'Add a specialist',
  onboardBody:
    'Say, one assistant for writing and one for research. Each keeps its own memory, and they can message each other.',
  message: 'Message',
  edit: 'Edit',
  moreActions: 'More actions',
  pin: 'Pin to top',
  unpin: 'Unpin',
  moveToGroup: 'Add to a group…',
  changeGroup: group => `Group: ${group}…`,
  duplicate: 'Duplicate',
  newChatWith: 'Start a separate chat',
  delete: 'Delete assistant…',
  lastActive: when => `Active ${when}`,
  neverActive: 'Not used yet',
  modelDefault: 'Default model',
  skillCount: n => (n === 1 ? '1 skill' : `${n} skills`),
  noDescription: 'No description yet — add one so this assistant knows what it helps with.',
  mentionTip: handle => `Type @${handle} in any chat to ask this assistant.`,
  routinesTitle: 'Scheduled tasks',
  routinesDescription: 'Work this assistant does on its own, on your schedule.',
  addRoutine: 'Add task',
  routinesEmpty: 'Nothing scheduled. Try “every morning, summarize my inbox”.',
  routinesLoadError: 'Couldn’t load scheduled tasks.',
  routinesStale: 'Couldn’t refresh — showing the last list.',
  nextRun: when => `Next ${when}`,
  paused: 'Paused',
  lastFailed: 'Last run failed',
  failure: {
    drift_skip: 'Skipped: this assistant’s model changed after the task was created. Delete the task and add it again.',
    blocked_config: 'Couldn’t start: this assistant’s settings need updating.',
    interrupted: 'The last run was cut short (the app was closed or restarted).',
    stalled: 'The last run stalled and was stopped.',
    busy: 'The last run couldn’t start because another task was still running.',
    usage_limit: 'The last run stopped: the AI service reached its usage limit.',
    rate_limit: 'The last run failed: the AI service was busy.',
    timeout: 'The last run took too long and was stopped.',
    auth: 'The last run couldn’t reach the AI service. Try signing in again.',
    model_not_found: 'The last run couldn’t use the selected model. Pick another model for this assistant.',
    service_unavailable: 'The last run couldn’t use the AI service. Try again later.',
    unknown: 'Last run failed'
  },
  pauseRoutine: 'Pause',
  resumeRoutine: 'Resume',
  deleteRoutine: 'Delete task',
  deleteRoutineTitle: title => `Delete “${title}”?`,
  deleteRoutineBody: 'It won’t run again. Past results stay in the chat history.',
  routineUpdateFailed: 'Couldn’t update the task',
  routineUntitled: 'Untitled task',
  routineRanTitle: task => `“${task}” just ran`,
  routineRanBody: assistant => `${assistant} finished it. The result is on its page.`,
  routineFailedTitle: task => `“${task}” didn’t finish`,
  routineRanView: 'View',
  chatsTitle: 'Conversations',
  chatsDescription: 'The main conversation plus any separate chats.',
  mainChat: 'Main conversation',
  untitledChat: 'Untitled chat',
  chatsEmpty: 'No conversations yet.',
  mainChatEmpty: 'No messages yet — open it to start talking.',
  runsTitle: 'Scheduled task results',
  runsDescription: 'Each time a scheduled task runs, its result lands here.',
  showAllChats: n => `Show all ${n}`,
  showFewerChats: 'Show fewer',
  openFailed: 'Couldn’t open the chat',
  groupRoom: 'Group room',
  groupRoomTitle: group => `${group} room`,
  groupMembers: n => (n === 1 ? '1 assistant' : `${n} assistants`),
  groupNeedsYou: 'Needs you',
  groupTooFew: 'Add one more assistant to this group to open a shared room.',
  groupTooMany: (max, names) => `A room seats ${max} assistants — ${names} sits this one out.`,
  groupComposer: group => `Message ${group} — type @ to ask someone specific`,
  groupSend: 'Send',
  groupWorking: 'The assistants are replying…',
  groupSpeaking: name => `${name} is replying…`,
  groupEmptyTitle: group => `Start a discussion with ${group}`,
  groupEmpty: 'Write once — everyone in the group reads it and replies in turn.',
  groupStarters: {
    plan: 'Plan this week’s content together',
    ideas: 'Each of you, pitch one idea for our next campaign',
    today: 'What should each of you take on today?'
  },
  groupMention: name => `Ask ${name} directly`,
  groupOutOfRoom: name => `${name} · not in this room`,
  groupEveryone: 'Everyone',
  groupMentionList: 'Mention an assistant',
  groupAttach: 'Attach files',
  groupAttachRemove: name => `Remove ${name}`,
  groupAttachTooLarge: (name, mb) => `${name} is larger than ${mb} MB and was skipped`,
  groupAttachFailed: name => `Couldn’t read ${name}`,
  groupDropHint: 'Drop files to share them with the group',
  groupStop: 'Stop',
  groupStopped: 'Stopped — the group waits for your next message.',
  groupTurnFailed: name => `${name} couldn’t answer this time.`,
  groupTurnTimedOut: name => `${name} took too long and was skipped.`,
  groupElapsed: seconds => `${seconds}s`,
  groupYou: 'you',
  groupMemberGone: name => `${name} is no longer an assistant here.`,
  recentChatsTitle: 'Recent conversations',
  recentChatsDescription: 'Your latest chats with the main assistant. “Message” starts a new one.',
  groupApprovalTitle: name => `${name} asks permission to run this:`,
  groupApprovalAllow: 'Allow once',
  groupApprovalDeny: 'Don’t allow',
  you: 'You',
  clearRoom: 'Clear room history',
  back: 'Back',
  createTitle: 'New assistant',
  createDescription: 'Give it a name and tell it what it helps with. You can change everything later.',
  editTitle: 'Edit assistant',
  editDescription: name => `Profile, behavior and skills of ${name}.`,
  tabProfile: 'Profile',
  tabBehavior: 'Behavior',
  tabSkills: 'Skills & tools',
  templates: 'Start from',
  template: {
    research: {
      title: 'Researcher',
      description: 'Looks things up, compares sources and writes clear summaries with citations.'
    },
    writer: { title: 'Writer', description: 'Drafts posts, emails and documents in my voice, then tightens them.' },
    secretary: { title: 'Secretary', description: 'Keeps my to-dos, reminders and meeting notes organized.' },
    analyst: {
      title: 'Data analyst',
      description: 'Reads spreadsheets, does the math and explains the numbers plainly.'
    },
    translator: {
      title: 'Translator',
      description: 'Translates documents and messages, keeping terms and tone consistent.'
    }
  },
  nameLabel: 'Name',
  namePlaceholder: 'e.g. Mia – Finance',
  handleHint: handle => `Mention it in any chat as @${handle}`,
  descLabel: 'What does it help you with?',
  descPlaceholder: 'e.g. Tracks spending, matches invoices and reminds me before bills are due.',
  avatarLabel: 'Picture',
  shapesLabel: 'Shape',
  colorsLabel: 'Color',
  uploadImage: 'Upload a picture',
  generateImage: 'Generate with AI',
  generating: 'Generating…',
  generateUnavailable: 'No image model is set up, so pictures can’t be generated yet.',
  generateFailed: 'Couldn’t generate a picture',
  useShape: 'Use a face instead',
  imageTooLarge: 'That picture is too large (max 15 MB).',
  advanced: 'Advanced options',
  handleLabel: 'Mention name',
  handleHelp: 'Lowercase letters, numbers and dashes. Used as @name in chats.',
  handleTaken: handle => `@${handle} is already taken.`,
  handleInvalid: 'Use lowercase letters, numbers and dashes.',
  cloneLabel: 'Start with settings from',
  cloneFresh: 'A fresh assistant',
  cloneFrom: name => `Copy of ${name}`,
  modelLabel: 'AI model',
  modelHelp: 'Leave it on the default unless this assistant needs a specific model.',
  modelInherit: 'Use the app default',
  modelLoading: 'Loading models…',
  instructionsLabel: 'Personal instructions',
  instructionsHelp: 'How it should talk, what to focus on, what to avoid. Leave empty to use the description.',
  instructionsPlaceholder: 'e.g. Reply briefly and in Vietnamese. Always ask before sending anything on my behalf.',
  shareAuth: 'Share sign-ins and API keys with AgentX',
  shareAuthHelp: 'Recommended. Turn off to give this assistant its own separate copy.',
  skillsHelp: 'Turn off what this assistant shouldn’t use. Changes apply to its next conversation.',
  skillsFilter: 'Filter skills',
  skillsNone: 'No skills match.',
  toolsLabel: 'Tools',
  toolsHelp: 'Leave all on to keep the default set.',
  capsLoadError: 'Couldn’t load skills for this assistant.',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  createAction: 'Create assistant',
  creating: 'Creating…',
  created: name => `${name} is ready`,
  saved: name => `${name} updated`,
  savedLocally: 'Saved on this computer only — the server didn’t accept the change.',
  partialSave: sections => `Some changes weren’t saved: ${sections}`,
  createFailed: 'Couldn’t create the assistant',
  deleteTitle: name => `Delete ${name}?`,
  deleteBody: 'Its memory, skills, scheduled tasks and every conversation are removed for good.',
  deleteConfirm: 'Delete',
  deleting: 'Deleting…',
  deleted: name => `${name} deleted`,
  groupDialogTitle: 'Add to a group',
  groupDialogDescription: 'Assistants in the same group share a room: write once, and they discuss it together.',
  groupNewPlaceholder: 'New group name, e.g. Marketing',
  groupCreate: 'Add',
  groupRemove: group => `Remove from “${group}”`,
  movedToGroup: (name, group) => `${name} joined “${group}”`,
  removedFromGroup: name => `${name} left its group`,
  duplicating: name => `Duplicating ${name}…`,
  duplicated: name => `${name} created`,
  duplicateFailed: 'Couldn’t duplicate the assistant',
  copySuffix: '(copy)',
  routineDialogTitle: 'New scheduled task',
  routineDialogDescription: name => `${name} will do this on its own. Results land in its conversations.`,
  routineNameLabel: 'Name',
  routineNamePlaceholder: 'e.g. Morning news brief',
  routineTaskLabel: 'What should it do?',
  routineTaskPlaceholder: 'e.g. Summarize the top 5 tech headlines in 5 bullet points.',
  whenLabel: 'When',
  freq: {
    once: 'Once',
    hourly: 'Every hour',
    daily: 'Every day',
    weekdays: 'Weekdays',
    weekly: 'Every week',
    monthly: 'Every month',
    interval: 'Repeat every…',
    advanced: 'Custom (cron)'
  },
  weekday: {
    '1': 'Monday',
    '2': 'Tuesday',
    '3': 'Wednesday',
    '4': 'Thursday',
    '5': 'Friday',
    '6': 'Saturday',
    '0': 'Sunday'
  },
  unit: { m: 'minutes', h: 'hours', d: 'days' },
  atTime: 'at',
  onDay: 'on day',
  inLabel: 'in',
  everyLabel: 'every',
  advancedSchedulePlaceholder: 'e.g. 0 9 * * 1-5 or every 2h',
  stopAfter: 'Stop after',
  stopAfterHelp: 'runs (empty = keep going)',
  scheduleCreate: 'Schedule',
  scheduling: 'Scheduling…',
  routineCreated: title => `“${title}” scheduled`,
  routineInvalid: 'Name and task can’t contain invisible control characters.',
  sDaily: time => `Every day at ${time}`,
  sWeekdays: time => `Weekdays at ${time}`,
  sWeekly: (day, time) => `Every ${day} at ${time}`,
  sMonthly: (day, time) => `Day ${day} of each month at ${time}`,
  sEveryMinutes: n => `Every ${n} minutes`,
  sEveryHours: n => (n === 1 ? 'Every hour' : `Every ${n} hours`),
  sEveryDays: n => (n === 1 ? 'Every day' : `Every ${n} days`),
  sHourly: 'Every hour',
  sOnceIn: after => `Once, in ${after}`,
  sOnceAt: when => `Once, ${when}`,
  sRaw: schedule => `Custom: ${schedule}`,
  sTimes: n => (n === 1 ? ', 1 time' : `, ${n} times`),
  neverResetTitle: 'This conversation keeps going',
  neverResetBody:
    'An assistant’s main conversation doesn’t reset — tidied it up instead. Use “Start a separate chat” for a clean slate.',
  paletteOpen: 'Assistants: Open',
  paletteNew: 'Assistants: New assistant'
}

const vi: BotsMessages = {
  nav: 'Trợ lý',
  work: 'Work',
  workspaceNavigation: 'Work và Trợ lý',
  pageTitle: 'Trợ lý',
  pageDescription:
    'Mỗi trợ lý có tên, trí nhớ và cuộc trò chuyện riêng. Giao việc, đặt lịch tự động, hoặc để các trợ lý phối hợp với nhau.',
  search: 'Tìm trợ lý',
  create: 'Tạo trợ lý',
  primaryName: 'AgentX',
  primaryRole: 'Trợ lý chính',
  sectionActive: 'Đang làm việc',
  sectionPinned: 'Đã ghim',
  sectionBots: 'Trợ lý',
  noMessages: 'Chưa có tin nhắn',
  fromBot: handle => `Từ @${handle}`,
  unread: 'Có hoạt động mới',
  working: 'Đang làm',
  noMatch: query => `Không có trợ lý nào khớp “${query}”.`,
  loading: 'Đang tải danh sách trợ lý…',
  loadError: 'Chưa tải được danh sách trợ lý.',
  waitingGateway: 'Đang chờ AgentX kết nối…',
  retry: 'Thử lại',
  staleNotice: 'Chưa làm mới được — đang hiện danh sách gần nhất.',
  onboardTitle: 'Thêm trợ lý chuyên trách',
  onboardBody:
    'Ví dụ một trợ lý lo viết nội dung, một trợ lý lo nghiên cứu. Mỗi trợ lý nhớ việc riêng và có thể nhắn cho nhau.',
  message: 'Nhắn tin',
  edit: 'Chỉnh sửa',
  moreActions: 'Thao tác khác',
  pin: 'Ghim lên đầu',
  unpin: 'Bỏ ghim',
  moveToGroup: 'Đưa vào nhóm…',
  changeGroup: group => `Nhóm: ${group}…`,
  duplicate: 'Nhân bản',
  newChatWith: 'Mở cuộc trò chuyện riêng',
  delete: 'Xoá trợ lý…',
  lastActive: when => `Hoạt động ${when}`,
  neverActive: 'Chưa dùng lần nào',
  modelDefault: 'Mô hình mặc định',
  skillCount: n => `${n} kỹ năng`,
  noDescription: 'Chưa có mô tả — thêm mô tả để trợ lý biết nó giúp bạn việc gì.',
  mentionTip: handle => `Gõ @${handle} trong bất kỳ cuộc trò chuyện nào để nhờ trợ lý này.`,
  routinesTitle: 'Lịch tự động',
  routinesDescription: 'Những việc trợ lý tự làm theo giờ bạn đặt.',
  addRoutine: 'Thêm lịch',
  routinesEmpty: 'Chưa có lịch nào. Thử “mỗi sáng, tóm tắt hộp thư cho tôi”.',
  routinesLoadError: 'Chưa tải được lịch tự động.',
  routinesStale: 'Chưa làm mới được — đang hiện danh sách gần nhất.',
  nextRun: when => `Lần tới ${when}`,
  paused: 'Đang tạm dừng',
  lastFailed: 'Lần chạy trước bị lỗi',
  failure: {
    drift_skip: 'Bị bỏ qua vì model của trợ lý đã đổi sau khi tạo lịch. Hãy xoá lịch này rồi thêm lại.',
    blocked_config: 'Không chạy được vì thiết lập của trợ lý cần cập nhật.',
    interrupted: 'Lần chạy trước bị ngắt giữa chừng (ứng dụng bị đóng hoặc khởi động lại).',
    stalled: 'Lần chạy trước bị treo nên đã dừng.',
    busy: 'Lần chạy trước không bắt đầu được vì một việc khác còn đang chạy.',
    usage_limit: 'Lần chạy trước dừng vì dịch vụ AI đã hết hạn mức sử dụng.',
    rate_limit: 'Lần chạy trước lỗi vì dịch vụ AI đang quá tải.',
    timeout: 'Lần chạy trước mất quá nhiều thời gian nên đã dừng.',
    auth: 'Lần chạy trước không kết nối được dịch vụ AI. Hãy thử đăng nhập lại.',
    model_not_found: 'Lần chạy trước không dùng được model đã chọn. Hãy chọn model khác cho trợ lý.',
    service_unavailable: 'Lần chạy trước không dùng được dịch vụ AI. Hãy thử lại sau.',
    unknown: 'Lần chạy trước bị lỗi'
  },
  pauseRoutine: 'Tạm dừng',
  resumeRoutine: 'Chạy tiếp',
  deleteRoutine: 'Xoá lịch',
  deleteRoutineTitle: title => `Xoá “${title}”?`,
  deleteRoutineBody: 'Lịch này sẽ không chạy nữa. Kết quả cũ vẫn còn trong lịch sử trò chuyện.',
  routineUpdateFailed: 'Chưa cập nhật được lịch',
  routineUntitled: 'Lịch chưa đặt tên',
  routineRanTitle: task => `Lịch “${task}” vừa chạy xong`,
  routineRanBody: assistant => `${assistant} đã làm xong. Kết quả nằm ở trang của trợ lý.`,
  routineFailedTitle: task => `Lịch “${task}” chạy chưa xong`,
  routineRanView: 'Xem',
  chatsTitle: 'Cuộc trò chuyện',
  chatsDescription: 'Cuộc trò chuyện chính và các cuộc trò chuyện riêng.',
  mainChat: 'Cuộc trò chuyện chính',
  untitledChat: 'Cuộc trò chuyện chưa đặt tên',
  chatsEmpty: 'Chưa có cuộc trò chuyện nào.',
  mainChatEmpty: 'Chưa có tin nhắn. Bấm để bắt đầu trò chuyện.',
  runsTitle: 'Kết quả lịch tự động',
  runsDescription: 'Mỗi lần lịch chạy, kết quả nằm ở đây.',
  showAllChats: n => `Xem tất cả ${n}`,
  showFewerChats: 'Thu gọn',
  openFailed: 'Chưa mở được cuộc trò chuyện',
  groupRoom: 'Phòng nhóm',
  groupRoomTitle: group => `Phòng ${group}`,
  groupMembers: n => `${n} trợ lý`,
  groupNeedsYou: 'Cần bạn',
  groupTooFew: 'Thêm ít nhất một trợ lý nữa vào nhóm này để mở phòng chung.',
  groupTooMany: (max, names) => `Một phòng có tối đa ${max} trợ lý — ${names} chưa tham gia lần này.`,
  groupComposer: group => `Nhắn cho nhóm ${group} — gõ @ để hỏi riêng một trợ lý`,
  groupSend: 'Gửi',
  groupWorking: 'Các trợ lý đang trả lời…',
  groupSpeaking: name => `${name} đang trả lời…`,
  groupEmptyTitle: group => `Bắt đầu thảo luận cùng nhóm ${group}`,
  groupEmpty: 'Nhắn một lần — cả nhóm cùng đọc rồi lần lượt trả lời.',
  groupStarters: {
    plan: 'Cùng lên kế hoạch nội dung cho tuần này',
    ideas: 'Mỗi người góp một ý tưởng cho chiến dịch tới',
    today: 'Hôm nay mỗi người nên lo việc gì?'
  },
  groupMention: name => `Hỏi riêng ${name}`,
  groupOutOfRoom: name => `${name} · chưa vào phòng`,
  groupEveryone: 'Cả nhóm',
  groupMentionList: 'Gọi tên một trợ lý',
  groupAttach: 'Đính kèm tệp',
  groupAttachRemove: name => `Bỏ ${name}`,
  groupAttachTooLarge: (name, mb) => `${name} lớn hơn ${mb} MB nên chưa gửi được`,
  groupAttachFailed: name => `Không đọc được ${name}`,
  groupDropHint: 'Thả tệp vào đây để gửi cho cả nhóm',
  groupStop: 'Dừng',
  groupStopped: 'Đã dừng — nhóm chờ tin nhắn tiếp theo của bạn.',
  groupTurnFailed: name => `${name} chưa trả lời được lần này.`,
  groupTurnTimedOut: name => `${name} trả lời quá lâu nên đã được bỏ qua.`,
  groupElapsed: seconds => `${seconds} giây`,
  groupYou: 'bạn',
  groupMemberGone: name => `${name} không còn là trợ lý ở đây.`,
  recentChatsTitle: 'Trò chuyện gần đây',
  recentChatsDescription: 'Những cuộc trò chuyện mới nhất với trợ lý chính. “Nhắn tin” mở một cuộc mới.',
  groupApprovalTitle: name => `${name} xin phép chạy lệnh này:`,
  groupApprovalAllow: 'Cho phép lần này',
  groupApprovalDeny: 'Không cho phép',
  you: 'Bạn',
  clearRoom: 'Xoá lịch sử phòng',
  back: 'Quay lại',
  createTitle: 'Tạo trợ lý',
  createDescription: 'Đặt tên và cho trợ lý biết nó giúp bạn việc gì. Bạn có thể đổi lại bất cứ lúc nào.',
  editTitle: 'Chỉnh sửa trợ lý',
  editDescription: name => `Hồ sơ, cách làm việc và kỹ năng của ${name}.`,
  tabProfile: 'Hồ sơ',
  tabBehavior: 'Cách làm việc',
  tabSkills: 'Kỹ năng & công cụ',
  templates: 'Bắt đầu nhanh',
  template: {
    research: { title: 'Nghiên cứu', description: 'Tìm hiểu, so sánh nguồn và viết tóm tắt rõ ràng, có dẫn nguồn.' },
    writer: {
      title: 'Biên tập nội dung',
      description: 'Soạn bài đăng, email, tài liệu theo giọng văn của tôi rồi trau chuốt lại.'
    },
    secretary: { title: 'Thư ký', description: 'Quản lý việc cần làm, lời nhắc và ghi chú cuộc họp cho gọn gàng.' },
    analyst: {
      title: 'Phân tích số liệu',
      description: 'Đọc bảng tính, tính toán và giải thích con số bằng lời dễ hiểu.'
    },
    translator: { title: 'Dịch thuật', description: 'Dịch tài liệu và tin nhắn, giữ thuật ngữ và giọng văn nhất quán.' }
  },
  nameLabel: 'Tên',
  namePlaceholder: 'Ví dụ: Minh – Kế toán',
  handleHint: handle => `Gọi trong trò chuyện bằng @${handle}`,
  descLabel: 'Trợ lý giúp bạn việc gì?',
  descPlaceholder: 'Ví dụ: Theo dõi chi tiêu, đối chiếu hoá đơn và nhắc tôi trước hạn thanh toán.',
  avatarLabel: 'Ảnh đại diện',
  shapesLabel: 'Hình dáng',
  colorsLabel: 'Màu',
  uploadImage: 'Tải ảnh lên',
  generateImage: 'Tạo bằng AI',
  generating: 'Đang tạo…',
  generateUnavailable: 'Chưa thiết lập mô hình tạo ảnh nên chưa tạo ảnh được.',
  generateFailed: 'Chưa tạo được ảnh',
  useShape: 'Dùng khuôn mặt mặc định',
  imageTooLarge: 'Ảnh quá lớn (tối đa 15 MB).',
  advanced: 'Tuỳ chọn nâng cao',
  handleLabel: 'Tên gọi khi nhắc',
  handleHelp: 'Chữ thường không dấu, số và dấu gạch ngang. Dùng dạng @tên trong trò chuyện.',
  handleTaken: handle => `@${handle} đã có trợ lý khác dùng.`,
  handleInvalid: 'Chỉ dùng chữ thường không dấu, số và dấu gạch ngang.',
  cloneLabel: 'Lấy thiết lập từ',
  cloneFresh: 'Trợ lý mới hoàn toàn',
  cloneFrom: name => `Bản sao của ${name}`,
  modelLabel: 'Mô hình AI',
  modelHelp: 'Cứ để mặc định, trừ khi trợ lý này cần một mô hình riêng.',
  modelInherit: 'Theo mặc định của ứng dụng',
  modelLoading: 'Đang tải danh sách mô hình…',
  instructionsLabel: 'Hướng dẫn riêng',
  instructionsHelp: 'Cách xưng hô, giọng văn, việc cần chú ý, điều nên tránh. Để trống thì trợ lý dựa theo mô tả.',
  instructionsPlaceholder:
    'Ví dụ: Trả lời ngắn gọn bằng tiếng Việt. Luôn hỏi tôi trước khi gửi bất cứ thứ gì thay tôi.',
  shareAuth: 'Dùng chung tài khoản đăng nhập và khoá API với AgentX',
  shareAuthHelp: 'Nên bật. Tắt đi nếu muốn trợ lý này có một bản riêng, tách biệt.',
  skillsHelp: 'Tắt những gì trợ lý này không nên dùng. Thay đổi áp dụng từ cuộc trò chuyện tiếp theo.',
  skillsFilter: 'Lọc kỹ năng',
  skillsNone: 'Không có kỹ năng nào khớp.',
  toolsLabel: 'Công cụ',
  toolsHelp: 'Để bật hết thì trợ lý dùng bộ công cụ mặc định.',
  capsLoadError: 'Chưa tải được kỹ năng của trợ lý này.',
  cancel: 'Huỷ',
  save: 'Lưu',
  saving: 'Đang lưu…',
  createAction: 'Tạo trợ lý',
  creating: 'Đang tạo…',
  created: name => `${name} đã sẵn sàng`,
  saved: name => `Đã cập nhật ${name}`,
  savedLocally: 'Chỉ lưu được trên máy này — máy chủ chưa nhận thay đổi.',
  partialSave: sections => `Một số thay đổi chưa lưu được: ${sections}`,
  createFailed: 'Chưa tạo được trợ lý',
  deleteTitle: name => `Xoá ${name}?`,
  deleteBody: 'Trí nhớ, kỹ năng, lịch tự động và mọi cuộc trò chuyện của trợ lý này sẽ bị xoá vĩnh viễn.',
  deleteConfirm: 'Xoá',
  deleting: 'Đang xoá…',
  deleted: name => `Đã xoá ${name}`,
  groupDialogTitle: 'Đưa vào nhóm',
  groupDialogDescription: 'Các trợ lý cùng nhóm có một phòng chung: nhắn một lần, cả nhóm cùng bàn.',
  groupNewPlaceholder: 'Tên nhóm mới, ví dụ: Marketing',
  groupCreate: 'Thêm',
  groupRemove: group => `Rời nhóm “${group}”`,
  movedToGroup: (name, group) => `${name} đã vào nhóm “${group}”`,
  removedFromGroup: name => `${name} đã rời nhóm`,
  duplicating: name => `Đang nhân bản ${name}…`,
  duplicated: name => `Đã tạo ${name}`,
  duplicateFailed: 'Chưa nhân bản được trợ lý',
  copySuffix: '(bản sao)',
  routineDialogTitle: 'Thêm lịch tự động',
  routineDialogDescription: name => `${name} sẽ tự làm việc này. Kết quả nằm trong các cuộc trò chuyện của trợ lý.`,
  routineNameLabel: 'Tên việc',
  routineNamePlaceholder: 'Ví dụ: Bản tin buổi sáng',
  routineTaskLabel: 'Trợ lý cần làm gì?',
  routineTaskPlaceholder: 'Ví dụ: Tóm tắt 5 tin công nghệ nổi bật nhất thành 5 gạch đầu dòng.',
  whenLabel: 'Khi nào',
  freq: {
    once: 'Một lần',
    hourly: 'Mỗi giờ',
    daily: 'Mỗi ngày',
    weekdays: 'Các ngày trong tuần',
    weekly: 'Mỗi tuần',
    monthly: 'Mỗi tháng',
    interval: 'Lặp lại sau mỗi…',
    advanced: 'Tuỳ chỉnh (cron)'
  },
  weekday: {
    '1': 'Thứ Hai',
    '2': 'Thứ Ba',
    '3': 'Thứ Tư',
    '4': 'Thứ Năm',
    '5': 'Thứ Sáu',
    '6': 'Thứ Bảy',
    '0': 'Chủ Nhật'
  },
  unit: { m: 'phút', h: 'giờ', d: 'ngày' },
  atTime: 'lúc',
  onDay: 'vào ngày',
  inLabel: 'sau',
  everyLabel: 'mỗi',
  advancedSchedulePlaceholder: 'Ví dụ: 0 9 * * 1-5 hoặc every 2h',
  stopAfter: 'Dừng sau',
  stopAfterHelp: 'lần chạy (để trống = chạy mãi)',
  scheduleCreate: 'Đặt lịch',
  scheduling: 'Đang đặt lịch…',
  routineCreated: title => `Đã đặt lịch “${title}”`,
  routineInvalid: 'Tên và nội dung không được chứa ký tự điều khiển ẩn.',
  sDaily: time => `Mỗi ngày lúc ${time}`,
  sWeekdays: time => `Thứ Hai – Thứ Sáu lúc ${time}`,
  sWeekly: (day, time) => `Mỗi ${day} lúc ${time}`,
  sMonthly: (day, time) => `Ngày ${day} hằng tháng lúc ${time}`,
  sEveryMinutes: n => `Mỗi ${n} phút`,
  sEveryHours: n => (n === 1 ? 'Mỗi giờ' : `Mỗi ${n} giờ`),
  sEveryDays: n => (n === 1 ? 'Mỗi ngày' : `Mỗi ${n} ngày`),
  sHourly: 'Mỗi giờ',
  sOnceIn: after => `Một lần, sau ${after}`,
  sOnceAt: when => `Một lần, ${when}`,
  sRaw: schedule => `Tuỳ chỉnh: ${schedule}`,
  sTimes: n => `, ${n} lần`,
  neverResetTitle: 'Cuộc trò chuyện này không làm mới',
  neverResetBody:
    'Cuộc trò chuyện chính của trợ lý luôn liền mạch — đã thu gọn ngữ cảnh thay vì làm mới. Dùng “Mở cuộc trò chuyện riêng” nếu muốn bắt đầu từ đầu.',
  paletteOpen: 'Trợ lý: Mở danh sách',
  paletteNew: 'Trợ lý: Tạo trợ lý mới'
}

export const BOTS_LOCALES: PluginLocaleBundles = { vi, en }

type Bound<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => string
    ? (...args: A) => string
    : T[K] extends object
      ? Bound<T[K]>
      : string
}

function bind<T extends object>(t: PluginTranslate, template: T, prefix = ''): Bound<T> {
  const out = {} as Record<string, unknown>

  for (const [key, value] of Object.entries(template)) {
    const path = prefix ? `${prefix}.${key}` : key
    out[key] =
      typeof value === 'function'
        ? (...args: unknown[]) => t(path, ...args)
        : value && typeof value === 'object'
          ? bind(t, value as object, path)
          : t(path)
  }

  return out as Bound<T>
}

export type BotsText = Bound<BotsMessages>

/** Bot Mode strings for the active locale. */
export function useBots(): BotsText {
  const t = usePluginI18n('agentx-bots')

  return useMemo(() => bind(t, en), [t])
}

/** Same strings outside React (composer middleware, palette). */
export function botsText(t: PluginTranslate): BotsText {
  return bind(t, en)
}

export const TEMPLATE_IDS: readonly TemplateId[] = ['research', 'writer', 'secretary', 'analyst', 'translator']
