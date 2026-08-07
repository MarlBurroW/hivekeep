UPDATE `user_profiles` SET `role` = 'member'
WHERE `role` = 'admin'
  AND `user_id` != (
    SELECT `up`.`user_id` FROM `user_profiles` `up`
    JOIN `user` `u` ON `u`.`id` = `up`.`user_id`
    WHERE `up`.`role` = 'admin'
    ORDER BY `u`.`created_at` ASC, `u`.`id` ASC
    LIMIT 1
  );
