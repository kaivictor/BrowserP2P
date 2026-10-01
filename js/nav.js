// nav.js —— 多页向导导航与返回键

const PAGES = ['page-role', 'page-signal', 'page-hub', 'page-chat', 'page-call', 'page-screen', 'page-clip', 'page-test'];

function goPage(id) {
  for (const p of PAGES) {
    const el = $(p);
    if (el) el.classList.toggle('hidden', p !== id);
  }
  // 进入聊天页时滚动到底部
  if (id === 'page-chat') scrollChat();
}

function goBack(btn) {
  const target = btn.getAttribute('data-back');
  if (target) goPage(target);
}
function isConnected() { return !!dc && dc.readyState === 'open'; }
// 已连接时，在“建立连接/选择身份”页显示“进入功能中心”按钮，方便误返回后一键回到功能页
function refreshConnectedNav() {
  const show = isConnected();
  document.querySelectorAll('.enter-hub-btn').forEach((b) => b.classList.toggle('hidden', !show));
}

// 返回键统一绑定（每页的 .back-btn 带 data-back）
function bindBackButtons() {
  document.querySelectorAll('.back-btn').forEach((b) => {
    b.addEventListener('click', () => goBack(b));
  });
  document.querySelectorAll('.enter-hub-btn').forEach((b) => {
    b.addEventListener('click', () => goPage('page-hub'));
  });
}

// DataChannel 建立后：刷新容量、跳到功能中心
function onChannelOpen() {
  updateChatCap();
  goPage('page-hub');
  hubStatus.textContent = '连接已建立，选择一个功能开始协作。';
  refreshConnectedNav();
  if (szWatchActive && typeof sendWatchInfo === 'function') sendWatchInfo(); // 通道重开：补发最新监看分辨率/缩放，避免上报被断线吞掉
}
