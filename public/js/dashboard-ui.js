document.addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  const sidebar = document.getElementById('appSidebar');
  const menuButton = document.querySelector('[data-sidebar-toggle]');
  const closeTargets = document.querySelectorAll('[data-sidebar-close]');
  const themeButton = document.querySelector('[data-theme-toggle]');
  const navLinks = Array.from(document.querySelectorAll('.sidebar-nav a[href^="#"]'));
  const dashboardRole = ['admin', 'company', 'driver'].find((role) => body.classList.contains(`role-${role}`));
  const desktopSidebarQuery = window.matchMedia('(min-width: 981px)');
  const sidebarStorageKey = dashboardRole ? `${dashboardRole}SidebarCollapsed` : 'dashboardSidebarCollapsed';

  const updateSidebarButton = () => {
    if (!menuButton) return;

    const isDesktopDashboard = Boolean(dashboardRole) && desktopSidebarQuery.matches;
    const isExpanded = isDesktopDashboard
      ? !body.classList.contains('sidebar-collapsed')
      : body.classList.contains('sidebar-open');
    const label = isDesktopDashboard
      ? (isExpanded ? 'إخفاء لوحة العمل' : 'إظهار لوحة العمل')
      : (isExpanded ? 'إغلاق القائمة' : 'فتح القائمة');

    menuButton.setAttribute('aria-expanded', String(isExpanded));
    menuButton.setAttribute('aria-label', label);
    menuButton.setAttribute('title', label);
  };

  const setMobileSidebarOpen = (isOpen) => {
    body.classList.toggle('sidebar-open', isOpen);
    updateSidebarButton();
  };

  const setDesktopSidebarCollapsed = (isCollapsed) => {
    if (!dashboardRole) return;
    body.classList.toggle('sidebar-collapsed', isCollapsed);
    localStorage.setItem(sidebarStorageKey, String(isCollapsed));
    updateSidebarButton();
  };

  if (dashboardRole) {
    body.classList.toggle('sidebar-collapsed', localStorage.getItem(sidebarStorageKey) === 'true');
  }
  updateSidebarButton();

  if (menuButton && sidebar) {
    menuButton.addEventListener('click', () => {
      if (dashboardRole && desktopSidebarQuery.matches) {
        setDesktopSidebarCollapsed(!body.classList.contains('sidebar-collapsed'));
        return;
      }

      setMobileSidebarOpen(!body.classList.contains('sidebar-open'));
    });
  }

  closeTargets.forEach((target) => {
    target.addEventListener('click', () => setMobileSidebarOpen(false));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !desktopSidebarQuery.matches) setMobileSidebarOpen(false);
  });

  window.addEventListener('resize', () => {
    if (desktopSidebarQuery.matches) body.classList.remove('sidebar-open');
    updateSidebarButton();
  });

  const updateThemeButton = () => {
    if (!themeButton) return;
    const isDark = body.classList.contains('dark-mode');
    themeButton.setAttribute('aria-label', isDark ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن');
    themeButton.setAttribute('title', isDark ? 'الوضع الفاتح' : 'الوضع الداكن');
    themeButton.innerHTML = isDark
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.3 8.3 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"></path></svg>';
  };

  if (localStorage.getItem('darkMode') === 'true') {
    body.classList.add('dark-mode');
  }
  updateThemeButton();

  if (themeButton) {
    themeButton.addEventListener('click', () => {
      body.classList.toggle('dark-mode');
      localStorage.setItem('darkMode', String(body.classList.contains('dark-mode')));
      updateThemeButton();
    });
  }

  navLinks.forEach((link) => {
    link.addEventListener('click', () => {
      navLinks.forEach((item) => item.classList.remove('active'));
      link.classList.add('active');
      if (!desktopSidebarQuery.matches) setMobileSidebarOpen(false);
    });
  });

  const sections = navLinks
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;

      navLinks.forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${visible.target.id}`);
      });
    }, { rootMargin: '-18% 0px -64% 0px', threshold: [0.05, 0.25] });

    sections.forEach((section) => observer.observe(section));
  }
});
