using System.ComponentModel;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace Cage.Windows;

internal sealed class TrayMenu : ContextMenuStrip
{
    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);

    internal Font SymbolFont { get; } = new("Segoe MDL2 Assets", 10f, FontStyle.Regular, GraphicsUnit.Point);

    public TrayMenu()
    {
        AccessibleName = "Cage 托盘菜单";
        AutoSize = false;
        ShowImageMargin = false;
        ShowCheckMargin = false;
        DropShadowEnabled = true;
        Font = SystemFonts.MenuFont!;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) SymbolFont.Dispose();
        base.Dispose(disposing);
    }

    public ToolStripMenuItem AddCommand(string label, string symbol, EventHandler click)
    {
        var command = new ToolStripMenuItem(label, null, click) { Tag = symbol };
        Items.Add(command);
        return command;
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (Width < 16 || Height < 16 || SystemInformation.HighContrast)
        {
            Region = null;
            return;
        }
        // WinForms drop-downs can have a square non-client frame even on Windows 11.
        using var path = new GraphicsPath();
        int radius = LogicalToDeviceUnits(8);
        path.AddRoundedRectangle(new Rectangle(0, 0, Width, Height), new Size(radius, radius));
        Region = new Region(path);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        if (OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
        {
            int corners = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(Handle, 33, ref corners, sizeof(int));
        }
    }

    protected override void OnOpening(CancelEventArgs e)
    {
        base.OnOpening(e);
        if (e.Cancel) return;
        Padding = new Padding(LogicalToDeviceUnits(5));
        int rightInset = LogicalToDeviceUnits(12);
        int leftInset = LogicalToDeviceUnits(SystemInformation.HighContrast ? 12 : 38);
        int width = LogicalToDeviceUnits(168);
        int rowHeight = Math.Max(LogicalToDeviceUnits(34), Font.Height + LogicalToDeviceUnits(10));
        foreach (ToolStripItem item in Items)
        {
            if (item is ToolStripSeparator) continue;
            width = Math.Max(width, TextRenderer.MeasureText(item.Text, Font).Width + leftInset + rightInset);
            item.Padding = new Padding(leftInset, 0, rightInset, 0);
            item.TextAlign = ContentAlignment.MiddleLeft;
        }
        foreach (ToolStripItem item in Items)
        {
            item.AutoSize = false;
            item.Size = new Size(width, item is ToolStripSeparator ? LogicalToDeviceUnits(7) : rowHeight);
        }
        int height = Padding.Vertical + Items.Cast<ToolStripItem>()
            .Where(item => item.Available).Sum(item => item.Height + item.Margin.Vertical);
        Size = new Size(width + Padding.Horizontal, height);
    }
}
