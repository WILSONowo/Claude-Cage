package managedproxy

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const windowsHardwareInterface = 1 << 0 // MIB_IF_ROW2.InterfaceAndOperStatusFlags.HardwareInterface

var (
	ipHelper              = windows.NewLazySystemDLL("iphlpapi.dll")
	getIPForwardTable2    = ipHelper.NewProc("GetIpForwardTable2")
	freeIPHelperTable     = ipHelper.NewProc("FreeMibTable")
	errNoWindowsInterface = errors.New("未找到可用的物理 IPv4 网卡。请连接以太网或 Wi-Fi；仅有虚拟网卡的 Windows 虚拟机和云主机暂不可用。Cage 外网保持关闭")
)

// The route table is allocated by IP Helper. RawSockaddrInet6 is the
// size and alignment of the Windows SOCKADDR_INET union.
type windowsIPForwardRow2 struct {
	InterfaceLuid  uint64
	InterfaceIndex uint32
	Destination    windows.RawSockaddrInet6
	PrefixLength   uint8
	_              [3]byte
	NextHop        windows.RawSockaddrInet6
	SitePrefixLen  uint8
	_              [3]byte
	ValidLifetime  uint32
	PreferredLife  uint32
	Metric         uint32
	Protocol       uint32
	Loopback       uint8
	AutoConfigure  uint8
	Publish        uint8
	Immortal       uint8
	Age            uint32
	Origin         uint32
}

type windowsIPForwardTable2 struct {
	Count uint32
	_     uint32
	Rows  [1]windowsIPForwardRow2
}

type windowsPhysicalAdapter struct {
	name   string
	metric uint32
}

func windowsPhysicalInterface(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	adapters, err := windowsPhysicalAdapters(ctx)
	if err != nil {
		return "", fmt.Errorf("无法读取 Windows 物理网卡信息；Cage 外网保持关闭: %w", err)
	}
	if len(adapters) == 0 {
		return "", errNoWindowsInterface
	}
	var table *windowsIPForwardTable2
	code, _, _ := getIPForwardTable2.Call(windows.AF_INET, uintptr(unsafe.Pointer(&table)))
	if code != 0 {
		return "", fmt.Errorf("无法读取 Windows IPv4 路由；Cage 外网保持关闭: %w", syscall.Errno(code))
	}
	if table == nil {
		return "", errNoWindowsInterface
	}
	defer freeIPHelperTable.Call(uintptr(unsafe.Pointer(table)))

	if err := ctx.Err(); err != nil {
		return "", err
	}
	rows := unsafe.Slice(&table.Rows[0], int(table.Count))
	name := selectWindowsPhysicalInterface(adapters, rows)
	if name == "" {
		return "", errNoWindowsInterface
	}
	return name, nil
}

func windowsPhysicalAdapters(ctx context.Context) (map[uint32]windowsPhysicalAdapter, error) {
	size := uint32(15000) // Recommended initial buffer for GetAdaptersAddresses.
	flags := uint32(windows.GAA_FLAG_SKIP_ANYCAST | windows.GAA_FLAG_SKIP_MULTICAST | windows.GAA_FLAG_SKIP_DNS_SERVER)
	var buffer []byte
	var first *windows.IpAdapterAddresses
	for attempts := 0; ; attempts++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		buffer = make([]byte, size)
		first = (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_INET, flags, 0, first, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) && size > uint32(len(buffer)) && attempts < 3 {
			continue
		}
		if errors.Is(err, windows.ERROR_NO_DATA) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		break
	}

	adapters := make(map[uint32]windowsPhysicalAdapter)
	for adapter := first; adapter != nil; adapter = adapter.Next {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if adapter.IfIndex == 0 || adapter.OperStatus != windows.IfOperStatusUp || !hasPreferredWindowsIPv4(adapter.FirstUnicastAddress) {
			continue
		}
		row := windows.MibIfRow2{InterfaceIndex: adapter.IfIndex}
		// WithoutStatistics avoids asking the driver for counters that we do not need.
		if err := windows.GetIfEntry2Ex(windows.MibIfEntryNormalWithoutStatistics, &row); err != nil ||
			row.InterfaceAndOperStatusFlags&windowsHardwareInterface == 0 ||
			row.OperStatus != windows.IfOperStatusUp {
			continue
		}
		if adapter.FriendlyName == nil {
			continue
		}
		name := windows.UTF16PtrToString(adapter.FriendlyName)
		if name != "" {
			adapters[adapter.IfIndex] = windowsPhysicalAdapter{name: name, metric: adapter.Ipv4Metric}
		}
	}
	runtime.KeepAlive(buffer)
	return adapters, nil
}

func hasPreferredWindowsIPv4(first *windows.IpAdapterUnicastAddress) bool {
	for address := first; address != nil; address = address.Next {
		if address.DadState != windows.IpDadStatePreferred || address.Address.Sockaddr == nil {
			continue
		}
		ip := address.Address.IP()
		if ip.To4() != nil && !ip.IsLinkLocalUnicast() && !ip.IsLoopback() && !ip.IsUnspecified() {
			return true
		}
	}
	return false
}

func selectWindowsPhysicalInterface(adapters map[uint32]windowsPhysicalAdapter, routes []windowsIPForwardRow2) string {
	var bestName string
	var bestMetric uint64
	var bestIndex uint32
	for _, route := range routes {
		adapter, ok := adapters[route.InterfaceIndex]
		if !ok || route.Destination.Family != windows.AF_INET || route.PrefixLength != 0 ||
			route.NextHop.Family != windows.AF_INET || route.Loopback != 0 {
			continue
		}
		nextHop := (*windows.RawSockaddrInet4)(unsafe.Pointer(&route.NextHop))
		if nextHop.Addr == [4]byte{} {
			continue
		}
		metric := uint64(route.Metric) + uint64(adapter.metric)
		if bestName == "" || metric < bestMetric || (metric == bestMetric && route.InterfaceIndex < bestIndex) {
			bestName, bestMetric, bestIndex = adapter.name, metric, route.InterfaceIndex
		}
	}
	return bestName
}
