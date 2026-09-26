# Decode a Ruida .rd file without Python (Windows PowerShell 5.1+).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\rddecode.ps1 -File test\golden\x.rd [-Head 140] [-Tail 20]
param([string]$File, [int]$Magic = 0x88, [int]$Head = 120, [int]$Tail = 25)

$names = @{
  '88'='MOVE_ABS'; '89'='MOVE_REL'; '8a'='MOVE_REL_X'; '8b'='MOVE_REL_Y';
  'a8'='CUT_ABS'; 'a9'='CUT_REL'; 'aa'='CUT_REL_X'; 'ab'='CUT_REL_Y';
  'c601'='MIN_POWER_1'; 'c602'='MAX_POWER_1'; 'c621'='MIN_POWER_2'; 'c622'='MAX_POWER_2';
  'c631'='MIN_POWER_1_PART'; 'c632'='MAX_POWER_1_PART'; 'c641'='MIN_POWER_2_PART'; 'c642'='MAX_POWER_2_PART';
  'c612'='LASER_ON_DELAY'; 'c613'='LASER_OFF_DELAY'; 'c660'='FREQUENCY_PART';
  'c902'='SPEED_LASER_1'; 'c904'='SPEED_LASER_1_PART'; 'c903'='SPEED_AXIS'; 'c906'='SPEED_AXIS_MOVE';
  'ca01'='LAYER_FLAG'; 'ca02'='LAYER_NUMBER_PART'; 'ca03'='EN_LASER_TUBE_START'; 'ca05'='LAYER_COLOR';
  'ca06'='LAYER_COLOR_PART'; 'ca22'='MAX_LAYER_PART'; 'ca41'='WORK_MODE_PART';
  'd7'='END_OF_FILE'; 'd800'='START_PROCESS'; 'd801'='STOP_PROCESS'; 'd810'='REF_POINT_2'; 'd811'='REF_POINT_1'; 'd812'='REF_POINT_0';
  'e505'='SET_FILE_SUM'; 'e601'='SET_ABSOLUTE';
  'e700'='BLOCK_END'; 'e701'='SET_FILENAME'; 'e703'='PROCESS_TOP_LEFT'; 'e704'='PROCESS_REPEAT'; 'e705'='ARRAY_DIRECTION';
  'e706'='FEED_REPEAT'; 'e707'='PROCESS_BOTTOM_RIGHT'; 'e708'='ARRAY_REPEAT'; 'e70a'='FEED_INFO'; 'e70b'='ARRAY_EN_MIRROR_CUT';
  'e713'='ARRAY_MIN_POINT'; 'e717'='ARRAY_MAX_POINT'; 'e723'='ARRAY_ADD'; 'e724'='ARRAY_MIRROR'; 'e738'='SET_FEED_AUTO_PAUSE';
  'e750'='DOCUMENT_MIN_POINT'; 'e751'='DOCUMENT_MAX_POINT'; 'e752'='PART_MIN_POINT'; 'e753'='PART_MAX_POINT';
  'e754'='PEN_OFFSET'; 'e755'='LAYER_OFFSET'; 'e760'='SET_CURRENT_ELEMENT_INDEX'; 'e761'='PART_MIN_POINT_EX'; 'e762'='PART_MAX_POINT_EX'; 'e737'='ARRAY_UNIT_SIZE'; 'da01'='SET_VARIABLE'; 'c650'='THROUGH_POWER_1'; 'c651'='THROUGH_POWER_2'; 'ca10'='LAYER_CA10'; 'f201'='ELEMENT_F201';
  'ea'='ARRAY_START'; 'eb'='ARRAY_END'; 'f0'='REF_POINT_SET'; 'f102'='ENABLE_BLOCK_CUTTING'; 'f103'='DISPLAY_OFFSET';
  'f100'='ELEMENT_MAX_INDEX'; 'f101'='ELEMENT_NAME_MAX_INDEX'; 'f200'='ELEMENT_INDEX'; 'f202'='ELEMENT_NAME';
  'f203'='ELEMENT_ARRAY_MIN_POINT'; 'f204'='ELEMENT_ARRAY_MAX_POINT'; 'f205'='ELEMENT_ARRAY'; 'f206'='ELEMENT_ARRAY_ADD'; 'f207'='ELEMENT_ARRAY_MIRROR';
}

function Unswizzle([int]$b) {
  $b = ($b - 1) -band 0xFF; $b = $b -bxor $Magic
  $b = $b -bxor (($b -shr 7) -band 0xFF); $b = $b -bxor (($b -shl 7) -band 0xFF); $b = $b -bxor (($b -shr 7) -band 0xFF)
  return $b
}

$raw = [IO.File]::ReadAllBytes($File)
$plain = New-Object byte[] $raw.Length
for ($i = 0; $i -lt $raw.Length; $i++) { $plain[$i] = [byte](Unswizzle $raw[$i]) }

# tokenize: new command at each high-bit byte
$cmds = New-Object System.Collections.Generic.List[byte[]]
$cur = New-Object System.Collections.Generic.List[byte]
foreach ($b in $plain) {
  if (($b -band 0x80) -and $cur.Count) { $cmds.Add($cur.ToArray()); $cur.Clear() }
  $cur.Add($b)
}
if ($cur.Count) { $cmds.Add($cur.ToArray()) }

function Hex([byte[]]$a) { ($a | ForEach-Object { $_.ToString('x2') }) -join ' ' }
function Name([byte[]]$c) {
  $k2 = if ($c.Length -ge 2) { $c[0].ToString('x2') + $c[1].ToString('x2') } else { '' }
  $k1 = $c[0].ToString('x2')
  if ($k2 -and $names.ContainsKey($k2)) { return @($names[$k2], 2) }
  if ($names.ContainsKey($k1)) { return @($names[$k1], 1) }
  return @("UNKNOWN_$k2", 1)
}
function D35([byte[]]$a, [int]$o) { $v = [long]0; for ($j = 0; $j -lt 5; $j++) { $v = ($v -shl 7) -bor $a[$o + $j] }; return $v }
function D14([byte[]]$a, [int]$o) { $v = ([int]$a[$o] -shl 7) -bor [int]$a[$o + 1]; if ($v -band 0x2000) { $v -= 0x4000 }; return $v }
function U14([byte[]]$a, [int]$o) { return ([int]$a[$o] -shl 7) -bor [int]$a[$o + 1] }
function Pretty([byte[]]$c) {
  $n, $kl = Name $c
  $d = $c[$kl..($c.Length - 1)]
  if ($c.Length -le $kl) { $d = @() }
  $extra = ''
  switch -Regex ($n) {
    '^(MOVE|CUT)_ABS$' { $extra = "x={0:N3}mm y={1:N3}mm" -f ((D35 $d 0) / 1000), ((D35 $d 5) / 1000) }
    '^(MOVE|CUT)_REL$' { $extra = "dx={0}um dy={1}um" -f (D14 $d 0), (D14 $d 2) }
    '^(MOVE|CUT)_REL_[XY]$' { $extra = "d={0}um" -f (D14 $d 0) }
    'POWER_\d$' { $extra = "{0:N1}%" -f ((U14 $d 0) * 100 / 16383) }
    'POWER_\d_PART$' { $extra = "part {0}: {1:N1}%" -f $d[0], ((U14 $d 1) * 100 / 16383) }
    '^SPEED_LASER_1$|^SPEED_AXIS' { $extra = "{0:N1} mm/s" -f ((D35 $d 0) / 1000) }
    '^SPEED_LASER_1_PART$' { $extra = "part {0}: {1:N1} mm/s" -f $d[0], ((D35 $d 1) / 1000) }
    'POINT|TOP_LEFT|BOTTOM_RIGHT' {
      $o = if ($d.Length -eq 11) { 1 } else { 0 }
      if ($d.Length -ge 10) { $extra = "({0:N3}, {1:N3}) mm" -f ((D35 $d $o) / 1000), ((D35 $d ($o + 5)) / 1000) }
    }
    'FILE_SUM' { $extra = "sum=$(D35 $d 0)" }
  }
  "{0,-26} {1,-40} {2}" -f $n, (Hex $c), $extra
}

"File: $File  ($($raw.Length) bytes, $($cmds.Count) commands, magic 0x$($Magic.ToString('x2')))"
$last = $cmds[$cmds.Count - 1]
"Last command: $(Hex $last)  -> $(if ($last.Length -eq 1 -and $last[0] -eq 0xD7) {'END_OF_FILE OK'} else {'NOT D7'})"

# checksum check: sum of all plain bytes before the E5 05 command, + 0xD7
$sumIdx = -1
for ($i = $plain.Length - 8; $i -ge 0; $i--) { if ($plain[$i] -eq 0xE5 -and $plain[$i + 1] -eq 0x05) { $sumIdx = $i; break } }
if ($sumIdx -ge 0) {
  $s = [long]0; for ($i = 0; $i -lt $sumIdx; $i++) { $s += $plain[$i] }
  $stored = D35 $plain ($sumIdx + 2)
  "Checksum: stored=$stored computed(sum before E5 05)=$s  +D7=$($s + 0xD7)"
}

"`n--- command counts ---"
$cmds | ForEach-Object { (Name $_)[0] } | Group-Object | Sort-Object Count -Descending | ForEach-Object { "{0,6}  {1}" -f $_.Count, $_.Name }

"`n--- first $Head commands ---"
$cmds | Select-Object -First $Head | ForEach-Object { Pretty $_ }
"`n--- last $Tail commands ---"
$cmds | Select-Object -Last $Tail | ForEach-Object { Pretty $_ }


