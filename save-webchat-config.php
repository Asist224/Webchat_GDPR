<?php
// save-webchat-config.php - Сохранение конфигурации веб-чата
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

// Проверка метода запроса
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Метод не разрешен']);
    exit;
}

// Получаем данные
$input = file_get_contents('php://input');
$requestData = json_decode($input, true);

if (!$requestData) {
    http_response_code(400);
    echo json_encode(['error' => 'Неверный формат данных']);
    exit;
}

// Логирование входящего запроса
error_log("=== НОВЫЙ ЗАПРОС === " . date('H:i:s'));
error_log("Тип операции: " . ($requestData['type'] ?? 'не указан'));
error_log("Данные запроса: " . json_encode($requestData, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR));

$configFile = 'webchat-config.js';

// Создаем директорию для резервных копий, если её нет
$backupDir = 'backups/';
if (!file_exists($backupDir)) {
    if (!mkdir($backupDir, 0755, true)) {
        error_log("Не удалось создать директорию backups");
    }
}

// Создаем резервную копию только если файл существует
if (file_exists($configFile)) {
    $backupName = 'webchat-config.backup.' . date('Y-m-d-H-i-s') . '.js';
    $backupPath = $backupDir . $backupName;

    if (copy($configFile, $backupPath)) {
        // Удаляем старые резервные копии, оставляем только последние 5
        $maxBackups = 5;

        $backupFiles = glob($backupDir . 'webchat-config.backup.*.js');

        usort($backupFiles, function($a, $b) {
            return filemtime($b) - filemtime($a);
        });

        if (count($backupFiles) > $maxBackups) {
            $filesToDelete = array_slice($backupFiles, $maxBackups);
            foreach ($filesToDelete as $file) {
                if (unlink($file)) {
                    error_log("Удалена старая резервная копия: " . basename($file));
                }
            }
        }

        error_log("Создана резервная копия: " . $backupName);
    } else {
        error_log("Не удалось создать резервную копию");
    }
}

// Читаем существующий файл
if (!file_exists($configFile)) {
    http_response_code(404);
    echo json_encode(['error' => 'Файл конфигурации не найден']);
    exit;
}

// ✅ ИСПРАВЛЕНИЕ: Очищаем кеш ПЕРЕД чтением файла
if (function_exists('opcache_invalidate')) {
    opcache_invalidate($configFile, true);
    error_log("Кеш файла очищен перед чтением");
}
clearstatcache(true, $configFile);

$originalContent = file_get_contents($configFile);
$type = $requestData['type'] ?? '';

try {
    $newContent = $originalContent;

    if ($type === 'global') {
        // Обновление глобальных настроек
        $globalSettings = $requestData['globalSettings'];

        // Конвертируем в JavaScript формат
        $jsGlobalSettings = convertToJavaScript($globalSettings, 0);

        // Используем функцию для точной замены блока с подсчетом скобок
        $newContent = replaceConfigBlock(
            $newContent,
            'const GlobalConfigSettings = ',
            'const GlobalConfigSettings = ' . $jsGlobalSettings . ';',
            ';'
        );

    } elseif ($type === 'global-partial') {
        // Частичное обновление глобальных настроек (обновляем только конкретные поля)
        $fieldsToUpdate = $requestData['fields'];

        // Обновляем каждое поле отдельно
        $newContent = updateGlobalConfigFields($newContent, $fieldsToUpdate);

    } elseif ($type === 'base') {
        // Обновление базовых настроек
        $baseConfig = $requestData['baseConfig'];

        // Конвертируем в JavaScript формат
        $jsBaseConfig = convertToJavaScript($baseConfig, 0);

        // Используем функцию для точной замены блока
        $newContent = replaceConfigBlock(
            $newContent,
            'const baseConfig = ',
            'const baseConfig = ' . $jsBaseConfig . ';',
            ';'
        );

    } elseif ($type === 'config') {
        // Обновление индивидуальной конфигурации
        $configId = $requestData['configId'];
        $configData = $requestData['configData'];

        // Конвертируем в JavaScript формат
        $jsConfigData = convertToJavaScript($configData, 0);

        // Для mergeConfigs нужно заменить только первый аргумент
        $newContent = replaceMergeConfigsBlock(
            $newContent,
            $configId,
            $jsConfigData
        );

    } elseif ($type === 'create') {
        // Создание новой конфигурации
        $configId = $requestData['configId'];
        $configData = $requestData['configData'];

        error_log("СОЗДАНИЕ: Создание конфигурации $configId");

        // Получаем order из configData
        $order = isset($configData['switcherSettings']['order']) ? $configData['switcherSettings']['order'] : 999;
        error_log("СОЗДАНИЕ: Order = $order");

        // Конвертируем в JavaScript формат
        $jsConfigData = convertToJavaScript($configData, 0);

        error_log("СОЗДАНИЕ: Конвертировано в JS, длина: " . strlen($jsConfigData) . " символов");

        // Добавляем новую конфигурацию в конец файла перед экспортом
        $newContent = addNewConfigBlock(
            $newContent,
            $configId,
            $jsConfigData,
            $order
        );

        error_log("СОЗДАНИЕ: Блок добавлен, новый размер файла: " . strlen($newContent) . " символов");

    } elseif ($type === 'delete') {
        // Удаление конфигурации
        $configId = $requestData['configId'];

        error_log("УДАЛЕНИЕ: Удаление конфигурации $configId");

        // Удаляем блок конфигурации
        $newContent = deleteConfigBlock(
            $newContent,
            $configId
        );

        error_log("УДАЛЕНИЕ: Блок удален, новый размер файла: " . strlen($newContent) . " символов");

    } else {
        http_response_code(400);
        echo json_encode(['error' => 'Неизвестный тип операции: ' . $type]);
        exit;
    }

    // Обновляем дату в комментарии
    $newContent = preg_replace(
        '/\/\/ Автоматически сохранено: .*$/m',
        '// Автоматически сохранено: ' . date('d.m.Y H:i:s'),
        $newContent
    );

    // Сохраняем файл
    error_log("СОХРАНЕНИЕ: Попытка записи файла, размер контента: " . strlen($newContent) . " байт");

    if (file_put_contents($configFile, $newContent)) {
        error_log("СОХРАНЕНИЕ: Файл записан успешно");

        if (file_exists($configFile) && filesize($configFile) > 0) {
            $fileSize = filesize($configFile);
            error_log("СОХРАНЕНИЕ: Файл существует, размер: $fileSize байт");

            echo json_encode([
                'success' => true,
                'message' => 'Конфигурация успешно сохранена',
                'type' => $type,
                'backup' => isset($backupName) ? $backupName : null,
                'timestamp' => date('Y-m-d H:i:s'),
                'fileSize' => $fileSize
            ], JSON_UNESCAPED_UNICODE);
        } else {
            error_log("СОХРАНЕНИЕ: ОШИБКА - файл не существует или пустой после записи");
            http_response_code(500);
            echo json_encode(['error' => 'Файл сохранен, но пустой или недоступен']);
        }
    } else {
        error_log("СОХРАНЕНИЕ: КРИТИЧЕСКАЯ ОШИБКА - file_put_contents вернул false");
        error_log("СОХРАНЕНИЕ: Проверка прав доступа к файлу: " . (is_writable($configFile) ? 'доступен для записи' : 'НЕ доступен для записи'));
        http_response_code(500);
        echo json_encode(['error' => 'Ошибка при сохранении файла']);
    }

} catch (Exception $e) {
    error_log("ОШИБКА ОБРАБОТКИ: " . $e->getMessage());
    error_log("ТРАССИРОВКА: " . $e->getTraceAsString());
    http_response_code(500);
    echo json_encode([
        'error' => 'Ошибка обработки: ' . $e->getMessage()
    ]);
}

// Функция замены блока конфигурации с подсчетом скобок
function replaceConfigBlock($content, $startPattern, $replacement, $endChar) {
    $startPos = strpos($content, $startPattern);

    if ($startPos === false) {
        throw new Exception('Не удалось найти начало блока: ' . $startPattern);
    }

    // Находим начало значения (после '=')
    $valueStart = strpos($content, '=', $startPos) + 1;
    $valueStart = strpos($content, '{', $valueStart); // Находим открывающую скобку

    if ($valueStart === false) {
        throw new Exception('Не удалось найти начало значения');
    }

    // Подсчитываем скобки для нахождения конца блока
    $braceCount = 0;
    $pos = $valueStart;
    $inString = false;
    $stringChar = '';
    $escaped = false;

    while ($pos < strlen($content)) {
        $char = $content[$pos];

        if ($escaped) {
            $escaped = false;
            $pos++;
            continue;
        }

        if ($char === '\\') {
            $escaped = true;
            $pos++;
            continue;
        }

        // Обработка строк
        if (($char === '"' || $char === "'" || $char === '`') && !$inString) {
            $inString = true;
            $stringChar = $char;
        } elseif ($char === $stringChar && $inString) {
            $inString = false;
            $stringChar = '';
        }

        // Подсчет скобок вне строк
        if (!$inString) {
            if ($char === '{') {
                $braceCount++;
            } elseif ($char === '}') {
                $braceCount--;

                if ($braceCount === 0) {
                    // Нашли закрывающую скобку
                    $endPos = strpos($content, $endChar, $pos);
                    if ($endPos === false) {
                        throw new Exception('Не удалось найти символ окончания: ' . $endChar);
                    }

                    // Заменяем блок
                    $before = substr($content, 0, $startPos);
                    $after = substr($content, $endPos + strlen($endChar));

                    return $before . $replacement . $after;
                }
            }
        }

        $pos++;
    }

    throw new Exception('Не удалось найти конец блока конфигурации');
}

// Функция замены блока mergeConfigs
function replaceMergeConfigsBlock($content, $configId, $newConfigData) {
    $startPattern = 'const ' . $configId . ' = mergeConfigs(';
    $startPos = strpos($content, $startPattern);

    if ($startPos === false) {
        throw new Exception('Не удалось найти конфигурацию: ' . $configId);
    }

    // Находим начало первого аргумента
    $argsStart = $startPos + strlen($startPattern);
    $firstArgStart = strpos($content, '{', $argsStart);

    if ($firstArgStart === false) {
        throw new Exception('Не удалось найти начало аргументов mergeConfigs');
    }

    // Подсчитываем скобки для первого аргумента
    $braceCount = 0;
    $pos = $firstArgStart;
    $inString = false;
    $stringChar = '';
    $escaped = false;

    while ($pos < strlen($content)) {
        $char = $content[$pos];

        if ($escaped) {
            $escaped = false;
            $pos++;
            continue;
        }

        if ($char === '\\') {
            $escaped = true;
            $pos++;
            continue;
        }

        // Обработка строк
        if (($char === '"' || $char === "'" || $char === '`') && !$inString) {
            $inString = true;
            $stringChar = $char;
        } elseif ($char === $stringChar && $inString) {
            $inString = false;
            $stringChar = '';
        }

        // Подсчет скобок вне строк
        if (!$inString) {
            if ($char === '{') {
                $braceCount++;
            } elseif ($char === '}') {
                $braceCount--;

                if ($braceCount === 0) {
                    // Нашли конец первого аргумента
                    $firstArgEnd = $pos + 1;

                    // Заменяем только первый аргумент
                    $before = substr($content, 0, $firstArgStart);
                    $after = substr($content, $firstArgEnd);

                    return $before . $newConfigData . $after;
                }
            }
        }

        $pos++;
    }

    throw new Exception('Не удалось найти конец аргументов mergeConfigs');
}

// Функция конвертации PHP массива в JavaScript объект
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

// Функция частичного обновления полей GlobalConfigSettings
function updateGlobalConfigFields($content, $fields) {
    // Находим начало GlobalConfigSettings
    $startPattern = 'const GlobalConfigSettings = {';
    $startPos = strpos($content, $startPattern);

    if ($startPos === false) {
        throw new Exception('Не удалось найти GlobalConfigSettings');
    }

    // Находим конец блока GlobalConfigSettings
    $braceCount = 0;
    $pos = $startPos + strlen($startPattern) - 1; // Позиция на {
    $inString = false;
    $stringChar = '';
    $escaped = false;
    $blockEnd = false;

    while ($pos < strlen($content) && !$blockEnd) {
        $char = $content[$pos];

        if ($escaped) {
            $escaped = false;
            $pos++;
            continue;
        }

        if ($char === '\\') {
            $escaped = true;
            $pos++;
            continue;
        }

        if (($char === '"' || $char === "'" || $char === '`') && !$inString) {
            $inString = true;
            $stringChar = $char;
        } elseif ($char === $stringChar && $inString) {
            $inString = false;
            $stringChar = '';
        }

        if (!$inString) {
            if ($char === '{') {
                $braceCount++;
            } elseif ($char === '}') {
                $braceCount--;
                if ($braceCount === 0) {
                    $blockEnd = $pos;
                    break;
                }
            }
        }

        $pos++;
    }

    if (!$blockEnd) {
        throw new Exception('Не удалось найти конец GlobalConfigSettings');
    }

    // Получаем блок GlobalConfigSettings
    $blockContent = substr($content, $startPos, $blockEnd - $startPos + 1);

    // Обновляем каждое поле
    foreach ($fields as $fieldName => $fieldValue) {
        $jsValue = convertToJavaScript($fieldValue, 0);

        // Ищем паттерн поля: "fieldName: значение," или "fieldName: значение"
        // Паттерн должен учитывать:
        // - пробелы перед именем поля
        // - двоеточие с пробелами
        // - значение (true, false, число, строка)
        // - пробелы после значения
        // - запятую (опционально)
        // - пробелы и комментарий до конца строки

        // Паттерн для поиска поля с примитивным значением
        $pattern = '/^(\s*' . preg_quote($fieldName, '/') . '\s*:\s*)(true|false|"[^"]*"|\d+|\'[^\']*\')(\s*,?\s*(?:\/\/.*)?$)/m';

        // Пробуем заменить
        $newBlockContent = preg_replace($pattern, '$1' . $jsValue . '$3', $blockContent, 1, $count);

        if ($count > 0) {
            $blockContent = $newBlockContent;
            error_log("Обновлено поле $fieldName на значение: $jsValue");
        } else {
            // Если не получилось простой заменой, значит это сложное значение (объект/массив)
            // Пробуем найти и заменить объект целиком
            error_log("Поле $fieldName имеет сложное значение, пытаемся обновить как объект");

            // Ищем начало поля: "fieldName: {"
            $objectPattern = '/^(\s*' . preg_quote($fieldName, '/') . '\s*:\s*)\{/m';
            if (preg_match($objectPattern, $blockContent, $matches, PREG_OFFSET_CAPTURE)) {
                $fieldStart = $matches[0][1];
                $valueStart = $fieldStart + strlen($matches[1][0]); // Позиция '{'

                // Считаем скобки для определения конца объекта
                $braceCount = 0;
                $pos = $valueStart;
                $inString = false;
                $stringChar = '';
                $escaped = false;
                $objectEnd = false;

                while ($pos < strlen($blockContent) && !$objectEnd) {
                    $char = $blockContent[$pos];

                    if ($escaped) {
                        $escaped = false;
                        $pos++;
                        continue;
                    }

                    if ($char === '\\') {
                        $escaped = true;
                        $pos++;
                        continue;
                    }

                    if (($char === '"' || $char === "'" || $char === '`') && !$inString) {
                        $inString = true;
                        $stringChar = $char;
                    } elseif ($char === $stringChar && $inString) {
                        $inString = false;
                        $stringChar = '';
                    }

                    if (!$inString) {
                        if ($char === '{') {
                            $braceCount++;
                        } elseif ($char === '}') {
                            $braceCount--;
                            if ($braceCount === 0) {
                                $objectEnd = $pos;
                                break;
                            }
                        }
                    }

                    $pos++;
                }

                if ($objectEnd !== false) {
                    // Находим конец строки после }, чтобы сохранить запятую и комментарии
                    $afterObject = $objectEnd + 1;
                    $lineEnd = strpos($blockContent, "\n", $afterObject);
                    if ($lineEnd === false) {
                        $lineEnd = strlen($blockContent);
                    }

                    // Получаем часть после } (запятая и комментарий)
                    $afterPart = substr($blockContent, $afterObject, $lineEnd - $afterObject);

                    // Заменяем объект
                    $before = substr($blockContent, 0, $fieldStart);
                    $after = substr($blockContent, $lineEnd);

                    $blockContent = $before . $matches[1][0] . $jsValue . $afterPart . $after;
                    error_log("Обновлено сложное поле $fieldName");
                } else {
                    error_log("Не удалось найти конец объекта для поля $fieldName");
                }
            } else {
                error_log("Поле $fieldName не найдено в блоке");
            }
        }
    }

    // Заменяем блок в контенте
    $before = substr($content, 0, $startPos);
    $after = substr($content, $blockEnd + 1);

    return $before . $blockContent . $after;
}

// Функция добавления записи в availableConfigs
function addToAvailableConfigs($content, $configId, $order) {
    error_log("Добавление $configId в availableConfigs с order=$order");

    // Находим начало блока availableConfigs
    $searchPattern = 'availableConfigs:';
    $startPos = strpos($content, $searchPattern);

    if ($startPos === false) {
        error_log("ПРЕДУПРЕЖДЕНИЕ: Не удалось найти блок availableConfigs");
        return $content;
    }

    // Находим открывающую скобку после availableConfigs:
    $openBracePos = strpos($content, '{', $startPos);
    if ($openBracePos === false) {
        error_log("ПРЕДУПРЕЖДЕНИЕ: Не удалось найти открывающую скобку availableConfigs");
        return $content;
    }

    // Подсчитываем скобки, чтобы найти закрывающую скобку блока
    $braceCount = 0;
    $closeBracePos = false;
    $len = strlen($content);

    for ($i = $openBracePos; $i < $len; $i++) {
        if ($content[$i] === '{') {
            $braceCount++;
        } elseif ($content[$i] === '}') {
            $braceCount--;
            if ($braceCount === 0) {
                $closeBracePos = $i;
                break;
            }
        }
    }

    if ($closeBracePos === false) {
        error_log("ПРЕДУПРЕЖДЕНИЕ: Не удалось найти закрывающую скобку availableConfigs");
        return $content;
    }

    // Извлекаем содержимое блока
    $blockContent = substr($content, $openBracePos + 1, $closeBracePos - $openBracePos - 1);

    // Проверяем, есть ли уже эта конфигурация
    if (strpos($blockContent, $configId . ':') !== false) {
        error_log("Конфигурация $configId уже есть в availableConfigs, пропускаем");
        return $content;
    }

    // Добавляем новую запись перед закрывающей скобкой
    $newEntry = "        " . $configId . ": { enabled: true, order: " . $order . " }";

    // Проверяем, есть ли уже другие записи (нужна ли запятая)
    // Если в блоке есть хотя бы один Config, добавляем запятую
    if (preg_match('/\w+Config:\s*\{/', $blockContent)) {
        $newEntry = ",\n" . $newEntry;
    } else {
        $newEntry = "\n" . $newEntry . "\n    ";
    }

    // Собираем новый контент
    $before = substr($content, 0, $closeBracePos);
    $after = substr($content, $closeBracePos);

    $result = $before . $newEntry . "\n    " . $after;
    error_log("Запись добавлена в availableConfigs");
    return $result;
}

// Функция удаления записи из availableConfigs
function removeFromAvailableConfigs($content, $configId) {
    error_log("Удаление $configId из availableConfigs");

    // Паттерн для поиска и удаления записи
    // Ищем строку вида: configId: { enabled: true, order: X },
    // или configId: { enabled: true, order: X }
    $pattern = '/,?\s*' . preg_quote($configId, '/') . ':\s*\{\s*enabled:\s*(true|false)\s*,\s*order:\s*\d+\s*\}\s*,?\s*/';

    $newContent = preg_replace($pattern, '', $content, 1, $count);

    if ($count > 0) {
        error_log("Запись $configId удалена из availableConfigs");

        // Очищаем возможные лишние запятые
        $newContent = preg_replace('/availableConfigs:\s*\{\s*,/', 'availableConfigs: {', $newContent);
        $newContent = preg_replace('/,(\s*}\s*,?\s*\n\s*\/\/ )/', '$1', $newContent);

        return $newContent;
    }

    error_log("ПРЕДУПРЕЖДЕНИЕ: Запись $configId не найдена в availableConfigs");
    return $content;
}

// Функция добавления новой конфигурации
function addNewConfigBlock($content, $configId, $newConfigData, $order) {
    // ✅ НОВАЯ ЛОГИКА: Ищем маркер начала функций и вставляем ПЕРЕД ним
    // Это гарантирует что конфигурации будут до window.ChatConfigs

    $insertPos = false;

    // Ищем маркер начала блока функций
    $functionMarkers = [
        '// ===============================================\n// ✅ НОВЫЕ ФУНКЦИИ УПРАВЛЕНИЯ ТЕМОЙ',
        '// ===============================================\n// ФУНКЦИЯ ПРИМЕНЕНИЯ КОНФИГУРАЦИИ',
        '// ===============================================\n// ЭКСПОРТ КОНФИГУРАЦИЙ'
    ];

    foreach ($functionMarkers as $marker) {
        $markerPos = strpos($content, $marker);
        if ($markerPos !== false) {
            $insertPos = $markerPos;
            error_log("Найден маркер функций на позиции: $insertPos");
            break;
        }
    }

    // ✅ РЕЗЕРВНЫЙ ВАРИАНТ: Если маркер не найден, ищем последнюю "настоящую" конфигурацию
    // Исключаем baseConfig из поиска
    if ($insertPos === false) {
        error_log("Маркер функций не найден, ищем последнюю конфигурацию");

        // Ищем все строки const xxxConfig = mergeConfigs(
        preg_match_all('/^const\s+(\w+Config)\s*=\s*mergeConfigs\(/m', $content, $matches, PREG_OFFSET_CAPTURE);

        if (!empty($matches[0])) {
            // Фильтруем baseConfig
            $configMatches = array_filter($matches[1], function($match) {
                return $match[0] !== 'baseConfig';
            });

            if (!empty($configMatches)) {
                // Берем последнее совпадение
                $lastMatch = end($configMatches);
                $configName = $lastMatch[0];

                // Ищем строку window.configName = configName; после этой конфигурации
                $windowPattern = 'window.' . $configName . ' = ' . $configName . ';';
                $windowPos = strpos($content, $windowPattern, $lastMatch[1]);

                if ($windowPos !== false) {
                    $insertPos = strpos($content, "\n", $windowPos) + 1;
                    error_log("Найдена последняя конфигурация: $configName, вставка на позиции: $insertPos");
                }
            }
        }
    }

    // Если совсем ничего не нашли, вставляем в конец
    if ($insertPos === false) {
        error_log("ПРЕДУПРЕЖДЕНИЕ: Не найдено подходящее место для вставки, добавляем в конец файла");
        $insertPos = strlen($content);
    }

    // Формируем блок новой конфигурации
    $configBlock = "\n// ===============================================\n";
    $configBlock .= "// КОНФИГУРАЦИЯ: " . strtoupper($configId) . "\n";
    $configBlock .= "// ===============================================\n";
    $configBlock .= "const " . $configId . " = mergeConfigs(" . $newConfigData . ", baseConfig, configMethods);\n";
    $configBlock .= "window." . $configId . " = " . $configId . ";\n";

    // Вставляем блок
    $before = substr($content, 0, $insertPos);
    $after = substr($content, $insertPos);

    $contentWithConfig = $before . $configBlock . $after;

    // Добавляем запись в availableConfigs
    $contentWithConfig = addToAvailableConfigs($contentWithConfig, $configId, $order);

    return $contentWithConfig;
}

// Функция удаления конфигурации
function deleteConfigBlock($content, $configId) {
    // Ищем начало блока конфигурации
    $startPattern = 'const ' . $configId . ' = mergeConfigs(';
    $startPos = strpos($content, $startPattern);

    if ($startPos === false) {
        throw new Exception('Конфигурация не найдена: ' . $configId);
    }

    // Ищем начало комментария перед конфигурацией
    $commentStart = $startPos;
    for ($i = $startPos - 1; $i >= 0; $i--) {
        if (substr($content, $i, 4) === '// =') {
            $commentStart = $i;
            break;
        }
        // Если встретили другую конфигурацию, останавливаемся
        if (substr($content, $i, 6) === 'const ') {
            break;
        }
    }

    // Ищем строку window.configId = configId;
    $windowPattern = 'window.' . $configId . ' = ' . $configId . ';';
    $windowPos = strpos($content, $windowPattern, $startPos);

    if ($windowPos === false) {
        throw new Exception('Не найдена строка window.' . $configId);
    }

    // Конец блока - после точки с запятой и перевода строки
    $endPos = strpos($content, "\n", $windowPos) + 1;

    // Удаляем блок
    $before = substr($content, 0, $commentStart);
    $after = substr($content, $endPos);

    $contentWithoutConfig = $before . $after;

    // Удаляем запись из availableConfigs
    $contentWithoutConfig = removeFromAvailableConfigs($contentWithoutConfig, $configId);

    return $contentWithoutConfig;
}

// Очищаем кеш
if (function_exists('opcache_reset')) {
    opcache_reset();
}
if (function_exists('opcache_invalidate')) {
    opcache_invalidate($configFile, true);
}
clearstatcache(true);
?>
