param([Parameter(Mandatory=$true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
    if ($null -eq $root) { Write-Output 'EVE_UIA_NO_WINDOW'; exit 3 }
    $byButton = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    for ($i = 0; $i -lt 10; $i++) {
        $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byButton)
        for ($k = 0; $k -lt $items.Count; $k++) {
            $button = $items.Item($k)
            $name = [string]$button.Current.Name
            if ($name -notmatch '^(?i:play|play song|play track|play now)$') { continue }
            if (-not $button.Current.IsEnabled) { continue }
            $pattern = $null
            if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,
                [ref]$pattern)) {
                $pattern.Invoke()
                Write-Output 'EVE_UIA_INVOKED'
                exit 0
            }
            $legacy = $null
            if ($button.TryGetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern,
                [ref]$legacy)) {
                $legacy.DoDefaultAction()
                Write-Output 'EVE_UIA_INVOKED'
                exit 0
            }
        }
        Start-Sleep -Milliseconds 750
    }
    Write-Output 'EVE_UIA_PLAY_CONTROL_UNAVAILABLE'
    exit 2
} catch {
    Write-Output 'EVE_UIA_UNAVAILABLE'
    exit 4
}
