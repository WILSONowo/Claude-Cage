using System.Runtime.InteropServices;

namespace Cage.Windows;

internal sealed class WindowChrome(Color background, Color foreground, bool dark)
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    internal static Color ContrastingText(Color value) =>
        value.GetBrightness() < 0.5 ? Color.White : Color.Black;

    internal void Apply(IntPtr window, MenuStrip? menus)
    {
        bool accessible = SystemInformation.HighContrast;
        int darkFrame = dark && !accessible ? 1 : 0;
        DwmSetWindowAttribute(window, 20, ref darkFrame, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            int caption = accessible ? -1 : ColorTranslator.ToWin32(background);
            int text = accessible ? -1 : ColorTranslator.ToWin32(foreground);
            DwmSetWindowAttribute(window, 35, ref caption, sizeof(int)); // DWMWA_CAPTION_COLOR
            DwmSetWindowAttribute(window, 36, ref text, sizeof(int));    // DWMWA_TEXT_COLOR
        }

        if (menus != null) ApplyMenu(menus);
    }

    internal void ApplyMenu(ToolStrip menu)
    {
        bool accessible = SystemInformation.HighContrast;
        ToolStripRenderer renderer = accessible ? new ToolStripSystemRenderer()
            : new MenuRenderer(background, foreground);
        ApplyMenu(menu, renderer, accessible);
    }

    private void ApplyMenu(ToolStrip menu, ToolStripRenderer renderer, bool accessible)
    {
        menu.Renderer = renderer;
        menu.BackColor = accessible ? SystemColors.Menu : background;
        menu.ForeColor = accessible ? SystemColors.MenuText : foreground;
        foreach (ToolStripItem item in menu.Items)
        {
            item.ForeColor = menu.ForeColor;
            if (item is ToolStripMenuItem { HasDropDownItems: true } child)
                ApplyMenu(child.DropDown, renderer, accessible);
        }
        menu.Invalidate();
    }

    private sealed class MenuRenderer(Color fill, Color ink) : ToolStripProfessionalRenderer
    {
        private readonly Color highlight = Color.FromArgb((fill.R * 9 + ink.R) / 10,
            (fill.G * 9 + ink.G) / 10, (fill.B * 9 + ink.B) / 10);

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) =>
            e.Graphics.Clear(fill);

        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected && !e.Item.Pressed) return;
            using var brush = new SolidBrush(highlight);
            var bounds = new Rectangle(Point.Empty, e.Item.Size);
            if (e.ToolStrip is ToolStripDropDown)
            {
                int inset = e.ToolStrip.LogicalToDeviceUnits(3);
                bounds.Inflate(-inset, -e.ToolStrip.LogicalToDeviceUnits(1));
                int radius = (int)Math.Round(5 * e.ToolStrip.DeviceDpi / 96d);
                var saved = e.Graphics.Save();
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                e.Graphics.FillRoundedRectangle(brush, bounds, new Size(radius, radius));
                e.Graphics.Restore(saved);
            }
            else e.Graphics.FillRectangle(brush, bounds);
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            if (e.ToolStrip is TrayMenu tray && e.Item is ToolStripMenuItem)
            {
                int inset = e.Item.Padding.Left;
                var bounds = new Rectangle(inset, 0, Math.Max(0, e.Item.Width - e.Item.Padding.Horizontal), e.Item.Height);
                if (e.Item.Tag is string symbol)
                {
                    int column = e.ToolStrip.LogicalToDeviceUnits(20);
                    var icon = new Rectangle(e.ToolStrip.LogicalToDeviceUnits(10), 0, column, bounds.Height);
                    TextRenderer.DrawText(e.Graphics, symbol, tray.SymbolFont, icon, e.TextColor,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
                }
                TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, bounds, e.TextColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                    TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
                return;
            }
            base.OnRenderItemText(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using var pen = new Pen(highlight);
            int y = e.Item.Height / 2;
            int inset = (int)Math.Round(10 * e.Graphics.DpiX / 96d);
            e.Graphics.DrawLine(pen, inset, y, e.Item.Width - inset, y);
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            if (e.ToolStrip is not ToolStripDropDown) return;
            using var pen = new Pen(highlight);
            var bounds = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            if (e.ToolStrip is TrayMenu)
            {
                int radius = e.ToolStrip.LogicalToDeviceUnits(8);
                var state = e.Graphics.Save();
                e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                e.Graphics.DrawRoundedRectangle(pen, bounds, new Size(radius, radius));
                e.Graphics.Restore(state);
            }
            else e.Graphics.DrawRectangle(pen, bounds);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = ink;
            base.OnRenderArrow(e);
        }
    }
}
