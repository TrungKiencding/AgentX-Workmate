import { LINKS } from '../lib/links'
import type { Dictionary } from './types'

/**
 * Tiếng Việt — bản gốc. Ba bản dịch còn lại bám theo file này.
 *
 * Mọi con số ở đây đếm được trong kho mã: 18 = `locales/*.yaml`, 6 kênh và 7
 * môi trường chạy = README, MIT = LICENSE. Không có số liệu marketing nào được
 * bịa ra ở đây — nếu một con số không kiểm chứng được thì nó không lên trang.
 */
export const vi: Dictionary = {
  meta: {
    title: 'AgentX Workmate — đồng nghiệp AI chạy trên máy bạn',
    description:
      'Tác nhân AI tự học, chạy ngay trên máy của bạn: mở terminal, đọc file, tự viết kỹ năng mới sau mỗi việc khó, và trả lời bạn từ Telegram, Discord hay Slack. Mã nguồn mở, giấy phép MIT.'
  },

  nav: {
    features: 'Khả năng',
    how: 'Cách bắt đầu',
    download: 'Tải về',
    docs: 'Tài liệu',
    openMenu: 'Mở menu',
    closeMenu: 'Đóng menu',
    language: 'Ngôn ngữ',
    skipToContent: 'Tới nội dung chính'
  },

  hero: {
    headline: 'Đồng nghiệp AI chạy trên máy bạn.',
    lede: 'AgentX Workmate mở terminal thật, đọc và sửa file trong thư mục bạn chỉ định, rồi tự viết lại cách làm thành kỹ năng cho lần sau. Rời bàn làm việc thì nhắn cho nó qua Telegram.',
    primaryCta: 'Tải về',
    secondaryCta: 'Xem mã nguồn',
    installLabel: 'macOS · Linux · WSL2',
    installNote: 'Windows dùng PowerShell — lệnh ở mục Tải về.',
    copy: 'Chép lệnh',
    copied: 'Đã chép',
    markAlt: 'Biểu tượng AgentX Workmate'
  },

  facts: [
    { value: '18', label: 'ngôn ngữ', note: 'Agent nói được, không chỉ trang này' },
    { value: '6', label: 'kênh trò chuyện', note: 'Telegram, Discord, Slack, WhatsApp, Signal, CLI' },
    { value: '7', label: 'môi trường chạy', note: 'Từ máy bạn tới container và máy chủ từ xa' },
    { value: 'MIT', label: 'giấy phép', note: 'Toàn bộ mã nguồn công khai trên GitHub' }
  ],

  comparison: {
    title: 'Tự ghép lấy, hay dùng cái đã ghép sẵn',
    lede: 'Mọi mảnh dưới đây đều tự làm được. Câu hỏi là bạn muốn dành mấy tuần cho phần nào.',
    columnDiy: 'Tự dựng một tác nhân',
    columnProduct: 'AgentX Workmate',
    rows: [
      {
        subject: 'Kết nối model',
        diy: 'Viết adapter cho từng nhà cung cấp, tự lo fallback khi một bên hỏng',
        product: 'Chọn trong agentx model — Nous Portal, OpenRouter, OpenAI, Anthropic, Ollama, endpoint riêng'
      },
      {
        subject: 'Chạy lệnh',
        diy: 'Tự dựng sandbox, tự quyết định lệnh nào được phép',
        product: 'Bảy môi trường chạy sẵn: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox'
      },
      {
        subject: 'Trí nhớ',
        diy: 'Tự thiết kế lược đồ lưu trữ và cơ chế tìm lại',
        product: 'Bộ nhớ do agent tự chăm, tìm kiếm toàn văn xuyên các phiên cũ'
      },
      {
        subject: 'Kỹ năng',
        diy: 'Tự gom thư viện prompt rồi tự nhớ ra lúc cần',
        product: 'Agent tự viết kỹ năng sau việc khó và tự sửa chúng trong lúc dùng'
      },
      {
        subject: 'Nhắn tin',
        diy: 'Mỗi nền tảng một con bot, mỗi con một vòng đời riêng',
        product: 'Một tiến trình gateway cho cả sáu kênh, mạch hội thoại nối liền giữa chúng'
      },
      {
        subject: 'Việc định kỳ',
        diy: 'Cắm cron, viết script, tự lo chuyện giao kết quả đi đâu',
        product: 'Lịch chạy tích hợp, mô tả bằng tiếng Việt, kết quả trả về đúng kênh bạn chọn'
      },
      {
        subject: 'Giao diện',
        diy: 'Một khung chat trong terminal, làm tới đâu dùng tới đó',
        product: 'TUI đầy đủ, app desktop cho macOS, Windows, Linux, và bảng điều khiển web'
      }
    ]
  },

  capabilities: {
    title: 'Nó làm được gì',
    lede: 'Không phải một khung chat có thêm nút. Đây là những thứ chạy nền khi bạn đóng cửa sổ.',
    tiles: [
      {
        key: 'terminal',
        title: 'Terminal thật, không phải hộp thoại giả',
        body: 'Soạn nhiều dòng, gõ tắt lệnh slash, xem output tool chảy theo thời gian thực, ngắt giữa chừng để đổi hướng mà không mất mạch hội thoại. Lịch sử phiên nằm ngay đó.',
        meta: 'TUI'
      },
      {
        key: 'memory',
        title: 'Trí nhớ có chủ đích',
        body: 'Agent tự nhắc mình ghi lại điều đáng nhớ, rồi tìm lại được trong các phiên đã đóng từ lâu.'
      },
      {
        key: 'skills',
        title: 'Kỹ năng tự sinh',
        body: 'Xong một việc khó, agent viết lại cách làm thành kỹ năng. Lần sau gặp lại, nó dùng và sửa tiếp.'
      },
      {
        key: 'browser',
        title: 'Điều khiển trình duyệt',
        body: 'WebMate đi kèm bộ cài, không phải vào cửa hàng tiện ích. Agent đọc trang, điền biểu mẫu, bấm nút — trong trình duyệt riêng của nó.',
        meta: 'WebMate'
      },
      {
        key: 'cron',
        title: 'Việc định kỳ',
        body: 'Báo cáo sáng thứ Hai, sao lưu lúc nửa đêm, rà soát cuối tuần — mô tả bằng lời, chạy khi bạn không ngồi máy.'
      },
      {
        key: 'subagents',
        title: 'Chia việc ra nhiều nhánh',
        body: 'Tách subagent chạy song song trong ngữ cảnh riêng, gom kết quả về một mối.'
      },
      {
        key: 'voice',
        title: 'Nghe và nói',
        body: 'Gửi tin nhắn thoại từ điện thoại, agent chép lại rồi làm. Trả lời bằng giọng nếu bạn muốn.'
      },
      {
        key: 'mcp',
        title: 'MCP và plugin',
        body: 'Cắm thêm máy chủ MCP, plugin và bộ công cụ riêng. Chuẩn kỹ năng theo agentskills.io.'
      },
      {
        key: 'local',
        title: 'Ở lại trên máy bạn',
        body: 'Không có tài khoản bắt buộc, không có hàng đợi phía máy chủ. File nằm trong thư mục bạn chọn.'
      }
    ]
  },

  loop: {
    title: 'Càng dùng, càng đỡ phải dặn',
    lede: 'Đây là chỗ AgentX Workmate khác một trợ lý hỏi–đáp: nó đóng vòng lặp giữa việc đã làm và việc sắp làm.',
    diagramTitle: 'Vòng lặp học của agent',
    steps: [
      { n: '1', title: 'Bạn giao việc', body: 'Bằng tiếng Việt, trong terminal, app desktop hay một tin nhắn.' },
      { n: '2', title: 'Agent làm và ghi lại', body: 'Vừa chạy vừa giữ lại các bước đã đi và những gì đã học được.' },
      { n: '3', title: 'Việc khó thành kỹ năng', body: 'Xong một việc nhiều bước, nó tự viết quy trình đó ra thành kỹ năng dùng lại được.' },
      { n: '4', title: 'Lần sau nhanh hơn', body: 'Gặp việc tương tự, nó lấy kỹ năng cũ ra dùng — và sửa chỗ nào chưa đúng.' }
    ],
    aside:
      'Bộ nhớ và tìm kiếm phiên cũ chạy song song với vòng lặp này: agent dựng dần một mô hình về cách bạn làm việc, thay vì bắt đầu lại từ con số không mỗi sáng.'
  },

  everywhere: {
    title: 'Ở đâu bạn làm việc, nó ở đó',
    lede: 'Một tiến trình gateway, nhiều cửa vào. Bỏ dở ở terminal, nói tiếp trên điện thoại.',
    channelsLabel: 'Kênh trò chuyện',
    channels: ['Telegram', 'Discord', 'Slack', 'WhatsApp', 'Signal', 'CLI'],
    surfacesLabel: 'Giao diện',
    surfaces: ['App desktop', 'TUI trong terminal', 'Bảng điều khiển web'],
    runtimesLabel: 'Môi trường chạy',
    runtimes: ['Local', 'Docker', 'SSH', 'Singularity', 'Modal', 'Daytona', 'Vercel Sandbox'],
    modelsLabel: 'Nhà cung cấp model',
    models: ['Nous Portal', 'OpenRouter', 'OpenAI', 'Anthropic', 'GitHub Copilot', 'Ollama', 'vLLM'],
    modelsNote: 'Đổi bằng một lệnh agentx model. Không sửa mã, không khoá vào ai.'
  },

  steps: {
    title: 'Từ lúc tải tới lúc giao việc đầu tiên',
    lede: 'Ba bước. Bộ cài lo phần Python, Node, ripgrep và ffmpeg.',
    steps: [
      {
        n: '01',
        title: 'Cài đặt',
        body: 'Tải bộ cài cho hệ điều hành của bạn, hoặc dán một dòng lệnh vào terminal.'
      },
      {
        n: '02',
        title: 'Chọn model',
        body: 'Đăng nhập nhà cung cấp bạn có sẵn, hoặc dán khoá API. Đổi lúc nào cũng được.',
        command: 'agentx model'
      },
      {
        n: '03',
        title: 'Giao việc',
        body: 'Mở app, hoặc gõ agentx trong terminal. Nối Telegram sau nếu bạn muốn nói chuyện lúc rời máy.',
        command: 'agentx'
      }
    ]
  },

  download: {
    title: 'Tải về',
    lede: 'Bộ cài desktop cho ba hệ điều hành, hoặc một dòng lệnh nếu bạn quen terminal.',
    platforms: [
      { key: 'mac', name: 'macOS', detail: 'Apple Silicon · Intel — .dmg', cta: 'Tải cho macOS' },
      { key: 'win', name: 'Windows', detail: 'Bộ cài .exe — không cần WSL', cta: 'Tải cho Windows' },
      { key: 'linux', name: 'Linux', detail: 'AppImage · .deb · .rpm', cta: 'Tải cho Linux' }
    ],
    releaseNote: 'Mọi bộ cài nằm ở trang Releases trên GitHub, kèm ghi chú phiên bản.',
    cliTitle: 'Hoặc cài bằng dòng lệnh',
    cliUnix: 'macOS · Linux · WSL2',
    cliWindows: 'Windows — PowerShell',
    cliAfter: 'Xong thì mở lại terminal và gõ agentx.',
    requirements: 'Bộ cài tự lo Python 3.11, Node.js, ripgrep và ffmpeg. Trên Windows còn kèm sẵn Git Bash rời, không đụng tới Git hệ thống.'
  },

  faq: {
    title: 'Câu hỏi hay gặp',
    items: [
      {
        q: 'AgentX Workmate là gì?',
        a: 'Một tác nhân AI chạy trên máy bạn: nó mở terminal, đọc và sửa file, gọi công cụ, và giữ lại những gì học được giữa các phiên. Có app desktop, giao diện terminal, và cổng nối tới Telegram, Discord, Slack, WhatsApp, Signal.'
      },
      {
        q: 'Dữ liệu của tôi có rời khỏi máy không?',
        a: 'Agent, bộ nhớ và file của bạn nằm trên máy bạn. Nhưng nội dung bạn gửi cho model thì đi tới nhà cung cấp model bạn chọn — đó là cách mọi trợ lý dùng model đám mây hoạt động. Muốn không gửi đi đâu cả thì trỏ AgentX vào Ollama hoặc vLLM chạy nội bộ.'
      },
      {
        q: 'Dùng được model nào?',
        a: 'Nous Portal, OpenRouter, OpenAI, Anthropic, GitHub Copilot, Ollama, vLLM và nhiều nhà cung cấp khác. Đổi bằng lệnh agentx model, không phải sửa mã.'
      },
      {
        q: 'Có mất phí không?',
        a: 'Phần mềm là mã nguồn mở theo giấy phép MIT — không có gói thuê bao ở đây. Bạn trả tiền cho nhà cung cấp model mình chọn, hoặc không trả đồng nào nếu chạy model nội bộ.'
      },
      {
        q: 'Chạy trên Windows được không?',
        a: 'Được, chạy thẳng không cần WSL: CLI, gateway, TUI và công cụ đều có bản Windows. Nếu bạn thích WSL2 thì lệnh cài của Linux cũng dùng được.'
      },
      {
        q: 'Mã nguồn ở đâu?',
        a: 'Toàn bộ trên GitHub, giấy phép MIT. Đọc được, sửa được, tự dựng lại được.'
      }
    ]
  },

  footer: {
    statement: 'Phần mềm chạy trên máy bạn. Trí nhớ ở lại với bạn.',
    license: 'Giấy phép MIT',
    builtBy: 'AstralX Technology',
    links: [
      { label: 'GitHub', href: LINKS.github },
      { label: 'Tài liệu', href: LINKS.docs },
      { label: 'Thảo luận', href: LINKS.discussions },
      { label: 'Releases', href: LINKS.releases }
    ]
  }
}
