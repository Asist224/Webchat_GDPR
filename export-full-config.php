<?php
// export-full-config.php - Экспорт полного файла webchat-config.js с измененными настройками
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Обработка preflight запроса
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Только POST запросы
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}

$configFile = 'webchat-config.js';

// Проверяем наличие файла
if (!file_exists($configFile)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Файл конфигурации не найден']);
    exit;
}

// Получаем данные из POST
$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data) {
    http_response_code(400);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Некорректные данные']);
    exit;
}

// Читаем оригинальный файл
$content = file_get_contents($configFile);

if ($content === false) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'error' => 'Не удалось прочитать файл']);
    exit;
}

// ✅ Функция конвертации PHP массива в JavaScript объект (как в save-webchat-config.php)
function convertToJavaScript($data, $indent = 0) {
    $indentStr = str_repeat('    ', $indent);
    $nextIndentStr = str_repeat('    ', $indent + 1);

    if (is_array($data)) {
        // Проверяем, это обычный массив или ассоциативный
        $isAssoc = array_keys($data) !== range(0, count($data) - 1);

        if ($isAssoc) {
            // Ассоциативный массив -> объект
            $lines = ['{'];
            $items = [];

            foreach ($data as $key => $value) {
                $jsKey = is_numeric($key) ? $key : (preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/', $key) ? $key : '"' . $key . '"');
                $jsValue = convertToJavaScript($value, $indent + 1);
                $items[] = $nextIndentStr . "$jsKey: $jsValue";
            }

            $lines[] = implode(",\n", $items);
            $lines[] = $indentStr . '}';

            return implode("\n", $lines);
        } else {
            // Обычный массив
            $lines = ['['];
            $items = [];

            foreach ($data as $value) {
                $jsValue = convertToJavaScript($value, $indent + 1);
                $items[] = $nextIndentStr . $jsValue;
            }

            $lines[] = implode(",\n", $items);
            $lines[] = $indentStr . ']';

            return implode("\n", $lines);
        }
    } elseif (is_bool($data)) {
        return $data ? 'true' : 'false';
    } elseif (is_null($data)) {
        return 'null';
    } elseif (is_numeric($data)) {
        return $data;
    } else {
        // Строка - экранируем специальные символы
        $escaped = str_replace(
            ['\\', '"', "\n", "\r", "\t"],
            ['\\\\', '\\"', '\\n', '\\r', '\\t'],
            $data
        );
        return '"' . $escaped . '"';
    }
}

/**
 * Функция для замены JavaScript объекта/массива в коде
 * Находит блок от "const/var/let NAME = {" до закрывающей "}" или "};"
 * Для mergeConfigs находит ВЕСЬ вызов функции включая все аргументы
 * СОХРАНЯЕТ оригинальное ключевое слово (const, var, let)
 */
function replaceJsObject($content, $varName, $newValue) {
    // Паттерн для поиска начала объекта с поддержкой const, var, let
    $patterns = [
        // Простой объект: const/var/let varName = {
        '/(const|var|let)\s+' . preg_quote($varName, '/') . '\s*=\s*\{/',
        // mergeConfigs: const/var/let varName = mergeConfigs({
        '/(const|var|let)\s+' . preg_quote($varName, '/') . '\s*=\s*mergeConfigs\s*\(\s*\{/'
    ];

    $startPos = false;
    $isMergeConfigs = false;
    $keyword = 'const'; // По умолчанию

    foreach ($patterns as $index => $pattern) {
        if (preg_match($pattern, $content, $matches, PREG_OFFSET_CAPTURE)) {
            $startPos = $matches[0][1];
            $keyword = $matches[1][0]; // Сохраняем оригинальное ключевое слово
            $isMergeConfigs = ($index === 1);
            break;
        }
    }

    if ($startPos === false) {
        return $content; // Не найдено - возвращаем как есть
    }

    $len = strlen($content);
    $actualEnd = $startPos;

    if ($isMergeConfigs) {
        // ✅ ИСПРАВЛЕНО: Для mergeConfigs находим ВЕСЬ вызов функции
        // Ищем открывающую скобку ( после mergeConfigs
        $parenPos = strpos($content, '(', $startPos);
        if ($parenPos === false) {
            return $content;
        }

        // Считаем круглые скобки для нахождения конца всего вызова mergeConfigs(...)
        $depth = 0;
        $inString = false;
        $stringChar = '';
        $escaped = false;

        for ($i = $parenPos; $i < $len; $i++) {
            $char = $content[$i];

            if ($escaped) {
                $escaped = false;
                continue;
            }

            if ($char === '\\') {
                $escaped = true;
                continue;
            }

            if ($inString) {
                if ($char === $stringChar) {
                    $inString = false;
                }
                continue;
            }

            if ($char === '"' || $char === "'" || $char === '`') {
                $inString = true;
                $stringChar = $char;
                continue;
            }

            if ($char === '(') {
                $depth++;
            } elseif ($char === ')') {
                $depth--;
                if ($depth === 0) {
                    $actualEnd = $i;
                    break;
                }
            }
        }
    } else {
        // Для простого объекта ищем закрывающую }
        $bracePos = strpos($content, '{', $startPos);
        if ($bracePos === false) {
            return $content;
        }

        $depth = 0;
        $inString = false;
        $stringChar = '';
        $escaped = false;

        for ($i = $bracePos; $i < $len; $i++) {
            $char = $content[$i];

            if ($escaped) {
                $escaped = false;
                continue;
            }

            if ($char === '\\') {
                $escaped = true;
                continue;
            }

            if ($inString) {
                if ($char === $stringChar) {
                    $inString = false;
                }
                continue;
            }

            if ($char === '"' || $char === "'" || $char === '`') {
                $inString = true;
                $stringChar = $char;
                continue;
            }

            if ($char === '{' || $char === '[') {
                $depth++;
            } elseif ($char === '}' || $char === ']') {
                $depth--;
                if ($depth === 0) {
                    $actualEnd = $i;
                    break;
                }
            }
        }
    }

    // Проверяем, есть ли точка с запятой после
    $hasTrailingSemicolon = false;
    $nextCharPos = $actualEnd + 1;
    while ($nextCharPos < $len && ctype_space($content[$nextCharPos])) {
        $nextCharPos++;
    }
    if ($nextCharPos < $len && $content[$nextCharPos] === ';') {
        $actualEnd = $nextCharPos;
        $hasTrailingSemicolon = true;
    }

    // Формируем замену - используем convertToJavaScript для правильного JS формата
    $jsValue = convertToJavaScript($newValue, 0);

    // ✅ ИСПРАВЛЕНО: Используем оригинальное ключевое слово (const, var, let)
    if ($isMergeConfigs) {
        $replacement = $keyword . ' ' . $varName . ' = mergeConfigs(' . $jsValue . ', baseConfig, configMethods)';
    } else {
        $replacement = $keyword . ' ' . $varName . ' = ' . $jsValue;
    }

    if ($hasTrailingSemicolon) {
        $replacement .= ';';
    }

    // Выполняем замену
    $before = substr($content, 0, $startPos);
    $after = substr($content, $actualEnd + 1);

    return $before . $replacement . $after;
}

// Заменяем конфигурации в файле
$modifiedContent = $content;

// Заменяем GlobalConfigSettings если передан
if (isset($data['GlobalConfigSettings'])) {
    $modifiedContent = replaceJsObject($modifiedContent, 'GlobalConfigSettings', $data['GlobalConfigSettings']);
}

// Заменяем основные конфигурации
$configNames = ['baseConfig', 'financeConfig', 'ecommerceConfig', 'techConfig', 'educationConfig'];

foreach ($configNames as $configName) {
    if (isset($data[$configName])) {
        $modifiedContent = replaceJsObject($modifiedContent, $configName, $data[$configName]);
    }
}

// Также проверяем, не передана ли конфигурация под другим именем (currentConfig)
if (isset($data['configName']) && isset($data['configData'])) {
    $modifiedContent = replaceJsObject($modifiedContent, $data['configName'], $data['configData']);
}

// Добавляем заголовок экспорта
$exportHeader = "// webchat-config.js - Экспорт с измененными настройками
// Экспортировано: " . date('d.m.Y H:i:s') . "
// =====================================================================================
// ПОЛНАЯ КОНФИГУРАЦИЯ ВЕБ-ЧАТА С ПОЛЬЗОВАТЕЛЬСКИМИ НАСТРОЙКАМИ
// Включает все настройки, переводы, тексты, функции и параметры
// =====================================================================================

";

// Заменяем оригинальный заголовок
$modifiedContent = preg_replace(
    '/^\/\/\s*webchat-config\.js.*?={5,}\s*/s',
    '',
    $modifiedContent,
    1
);

$finalContent = $exportHeader . $modifiedContent;

// Отправляем файл для скачивания
header('Content-Type: application/javascript; charset=utf-8');
header('Content-Disposition: attachment; filename="webchat-config-' . date('Y-m-d_H-i-s') . '.js"');
header('Content-Length: ' . strlen($finalContent));

echo $finalContent;
?>
