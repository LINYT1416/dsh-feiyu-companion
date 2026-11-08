$ErrorActionPreference = 'Stop'
$b = 'http://127.0.0.1:63090/silicon-life-companion'
$before = (Invoke-WebRequest "$b/state" -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
$orig = @{
  personaName        = $before.persona.name
  personaDescription = $before.persona.description
  personaPrompt      = $before.persona.systemPrompt
  traits             = $before.personality.traits
  warmth             = $before.personality.warmth
  curiosity          = $before.personality.curiosity
  pragmatism         = $before.personality.pragmatism
  moodDecayHours     = $before.moodSettings.decayHours
  injectionChars     = $before.settings.injectionChars
  sevenDayDays       = [math]::Round($before.settings.sevenDayMs / 86400000)
}
"BEFORE: name=$($orig.personaName) warmth=$($orig.warmth) decay=$($orig.moodDecayHours)"
$probe = $orig.Clone()
$probe.personaName = 'Companion验证'
$probe.warmth = 61
$probe.moodDecayHours = 48
$probe.injectionChars = 99999
$r1 = Invoke-WebRequest "$b/config" -Method POST -UseBasicParsing -TimeoutSec 30 -ContentType 'application/json' -Body ($probe | ConvertTo-Json -Compress)
$afterWrite = $r1.Content | ConvertFrom-Json
"AFTER WRITE: name=$($afterWrite.persona.name) warmth=$($afterWrite.personality.warmth) decay=$($afterWrite.moodSettings.decayHours) budget=$($afterWrite.settings.injectionChars)"
$reloaded = (Invoke-WebRequest "$b/state" -UseBasicParsing -TimeoutSec 20).Content | ConvertFrom-Json
"READBACK: name=$($reloaded.persona.name) warmth=$($reloaded.personality.warmth) decay=$($reloaded.moodSettings.decayHours)"
$restore = Invoke-WebRequest "$b/config" -Method POST -UseBasicParsing -TimeoutSec 30 -ContentType 'application/json' -Body ($orig | ConvertTo-Json -Compress)
$final = $restore.Content | ConvertFrom-Json
"RESTORED: name=$($final.persona.name) warmth=$($final.personality.warmth) decay=$($final.moodSettings.decayHours) budget=$($final.settings.injectionChars) traits=$($final.personality.traits)"
$injection = $final.injectionPreview
"INJECTION_HAS_PERSONA=" + ($injection -match '我是谁')
"INJECTION_HAS_TRAITS=" + ($injection -match '性格参数')
$clear = $null
try { $clear = Invoke-WebRequest "$b/clear" -Method POST -UseBasicParsing -TimeoutSec 20 -ContentType 'application/json' -Body '{"confirm":"CLEAR","buckets":["raw"]}' } catch { $clear = $_.Exception.Response }
"RAW_CLEAR_GUARD=" + [int]$clear.StatusCode
